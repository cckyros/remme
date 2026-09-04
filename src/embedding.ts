import { pipeline } from "@huggingface/transformers";

let extractor: any = null;
let modelName = "";

export async function embed(text: string, model: string): Promise<Float32Array> {
  if (process.env.REMME_DISABLE_EMBEDDING === "1") throw new Error("embedding disabled");
  if (!extractor || modelName !== model) {
    extractor = await pipeline("feature-extraction", model, { dtype: "q8" });
    modelName = model;
  }
  const output = await extractor(text, { pooling: "mean", normalize: true });
  return new Float32Array(output.data as Float32Array);
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0; let an = 0; let bn = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) { dot += a[i] * b[i]; an += a[i] ** 2; bn += b[i] ** 2; }
  return an && bn ? dot / Math.sqrt(an * bn) : 0;
}
