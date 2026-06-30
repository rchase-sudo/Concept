// supabase/functions/generate-concept/index.ts

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CLAUDE_API_KEY = Deno.env.get("CLAUDE_API_KEY")!;
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY")!;

const CLAUDE_MODEL = "claude-sonnet-4-6";
const GEMINI_IMAGE_MODEL = "gemini-2.5-flash-image";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_IMAGE_MODEL}:generateContent`;

const CLAUDE_SAFE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { generation_id } = await req.json();
    if (!generation_id) return jsonError("Missing generation_id", 400);

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const { data: gen, error: genErr } = await supabase
      .from("generations")
      .select("*")
      .eq("id", generation_id)
      .single();

    if (genErr || !gen) return jsonError("Generation not found", 404);

    await supabase.from("generations").update({ status: "analyzing" }).eq("id", generation_id);

    let sourceBase64: string | null = null;
    let sourceMediaType = "image/png";

    if (gen.source_path) {
      const { data: signed, error: signErr } = await supabase.storage
        .from("uploads")
        .createSignedUrl(gen.source_path, 60 * 30);
      if (signErr) {
        await failGeneration(supabase, generation_id, `Could not access source file: ${signErr.message}`);
        return jsonError(signErr.message, 500);
      }

      const imgResp = await fetch(signed.signedUrl);
      const buf = new Uint8Array(await imgResp.arrayBuffer());
      sourceBase64 = base64Encode(buf);
      const rawType = (imgResp.headers.get("content-type") || "image/png").split(";")[0].trim();
      sourceMediaType = CLAUDE_SAFE_TYPES.includes(rawType) ? rawType : "image/png";
    }

    let refinedPrompt = gen.prompt;
    let title = "Untitled Concept";
    try {
      const claudeResult = await refineWithClaude(gen.prompt, sourceBase64, sourceMediaType);
      refinedPrompt = claudeResult.refined_prompt;
      title = claudeResult.title;
    } catch (e) {
      console.error("Claude refinement failed:", e);
    }

    await supabase
      .from("generations")
      .update({ refined_prompt: refinedPrompt, title, status: "rendering" })
      .eq("id", generation_id);

    const imageBase64 = await generateWithGemini(refinedPrompt, sourceBase64, sourceMediaType);

    const imageBytes = Uint8Array.from(atob(imageBase64), (c) => c.charCodeAt(0));
    const outputPath = `outputs/${generation_id}.jpg`;

    const { error: uploadErr } = await supabase.storage
      .from("uploads")
      .upload(outputPath, imageBytes, { contentType: "image/jpeg", upsert: true });

    if (uploadErr) {
      await failGeneration(supabase, generation_id, `Upload failed: ${uploadErr.message}`);
      return jsonError(uploadErr.message, 500);
    }

    const { data: publicUrl } = supabase.storage.from("uploads").getPublicUrl(outputPath);

    await supabase
      .from("generations")
      .update({ status: "completed", result_url: publicUrl.publicUrl })
      .eq("id", generation_id);

    console.log("Generation completed:", generation_id);

    return new Response(JSON.stringify({ ok: true, result_url: publicUrl.publicUrl }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (e) {
    console.error("Top-level error:", e);
    return jsonError(e instanceof Error ? e.message : "Unknown error", 500);
  }
});

async function refineWithClaude(
  userPrompt: string,
  imageBase64: string | null,
  mediaType: string,
): Promise<{ refined_prompt: string; title: string }> {
  const content: Record<string, unknown>[] = [];

  if (imageBase64) {
    content.push({
      type: "image",
      source: { type: "base64", media_type: mediaType, data: imageBase64 },
    });
  }

  content.push({
    type: "text",
    text:
      `A user wants to generate an architectural / spatial concept image. ` +
      `Their request: "${userPrompt}"\n\n` +
      `Look at the attached reference (a floor plan, sketch, or site photo) if present, ` +
      `and write a single, detailed, vivid image-generation instruction that an AI image ` +
      `model can use to render a polished concept visual. Be specific about materials, ` +
      `lighting, mood, and composition, while staying faithful to the reference's layout ` +
      `and the user's intent. Also write a short 3-6 word title for this concept.\n\n` +
      `Respond ONLY with JSON, no markdown fences:\n` +
      `{"refined_prompt": "...", "title": "..."}`,
  });

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": CLAUDE_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 1000,
      messages: [{ role: "user", content }],
    }),
  });

  if (!resp.ok) throw new Error(`Claude API error: ${resp.status} ${await resp.text()}`);

  const data = await resp.json();
  const text = (data.content ?? [])
    .map((b: { type: string; text?: string }) => (b.type === "text" ? b.text : ""))
    .join("")
    .trim()
    .replace(/^```json\s*|\s*```$/g, "");

  const parsed = JSON.parse(text);
  if (!parsed.refined_prompt) throw new Error("Claude response missing refined_prompt");
  return { refined_prompt: parsed.refined_prompt, title: parsed.title || "Untitled Concept" };
}

async function generateWithGemini(
  prompt: string,
  imageBase64: string | null,
  mediaType: string,
): Promise<string> {
  const parts: Record<string, unknown>[] = [{ text: prompt }];

  if (imageBase64) {
    parts.push({ inline_data: { mime_type: mediaType, data: imageBase64 } });
  }

  const body = {
    contents: [{ role: "user", parts }],
    generationConfig: {
      responseModalities: ["TEXT", "IMAGE"],
    },
  };

  console.log("Calling Gemini model:", GEMINI_IMAGE_MODEL);

  const resp = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    console.error("Gemini API error response:", errText);
    throw new Error(`Gemini API error: ${resp.status} ${errText}`);
  }

  const data = await resp.json();

  console.log("Gemini response candidates count:", data?.candidates?.length);
  const rawParts = data?.candidates?.[0]?.content?.parts ?? [];
  console.log(
    "Gemini parts structure:",
    JSON.stringify(
      rawParts.map((p: Record<string, unknown>) => ({
        keys: Object.keys(p),
        inlineDataKeys: p.inlineData ? Object.keys(p.inlineData as object) : undefined,
        inline_dataKeys: p.inline_data ? Object.keys(p.inline_data as object) : undefined,
        textPreview: typeof p.text === "string" ? p.text.slice(0, 80) : undefined,
      }))
    )
  );

  const imagePart = rawParts.find((p: Record<string, unknown>) => {
    const inlineData = p.inlineData as { mimeType?: string; mime_type?: string } | undefined;
    const inline_data = p.inline_data as { mimeType?: string; mime_type?: string } | undefined;
    const mime =
      inlineData?.mimeType ||
      inlineData?.mime_type ||
      inline_data?.mimeType ||
      inline_data?.mime_type ||
      "";
    return mime.startsWith("image/");
  });

  if (!imagePart) {
    console.error("No image part found. Full response (trimmed):", JSON.stringify(data).slice(0, 800));
    throw new Error(
      `Gemini returned no image part. Finish reason: ${data?.candidates?.[0]?.finishReason ?? "unknown"}`
    );
  }

  const typedImagePart = imagePart as {
    inlineData?: { data?: string };
    inline_data?: { data?: string };
  };

  const imageData =
    typedImagePart.inlineData?.data ||
    typedImagePart.inline_data?.data ||
    "";

  if (!imageData) throw new Error("Gemini image part found but data field is empty.");

  console.log("Successfully extracted image data, length:", imageData.length);
  return imageData;
}

async function failGeneration(
  supabase: ReturnType<typeof createClient>,
  generationId: string,
  message: string,
) {
  console.error("Failing generation:", generationId, message);
  await supabase
    .from("generations")
    .update({ status: "failed", error_message: message })
    .eq("id", generationId);
}

function jsonError(message: string, status: number) {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
