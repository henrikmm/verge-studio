import type { Tensor } from "@huggingface/transformers";

/**
 * The exact browser model used to create measurement evidence.
 *
 * The repository revision is pinned because a model id that follows `main` is not
 * reproducible evidence. This revision contains the Transformers.js v3 metadata and
 * the fp16 ONNX encoder/decoder weights used by this prototype.
 */
export const SEGMENTATION_MODEL_ID = "Xenova/slimsam-77-uniform";
export const SEGMENTATION_MODEL_REVISION = "e6e86e6feaa8b1f8f325e81403e149ff76ce51bb";
export const SEGMENTATION_RUNTIME = "@huggingface/transformers@3.8.1";

export interface SegmentPrompt {
  /** Normalized image coordinate, from 0 to 1. */
  x: number;
  /** Normalized image coordinate, from 0 to 1. */
  y: number;
  /** 1 keeps the clicked object; 0 excludes the clicked region. */
  label: 0 | 1;
}

export interface SegmenterProgress {
  phase: "loading" | "encoding" | "ready" | "decoding";
  percent?: number;
  detail?: string;
}

export interface PreparedSegmentationFrame {
  imageUrl: string;
  width: number;
  height: number;
  modelLoadMs: number;
  modelLoadCached: boolean;
  frameEncodeMs: number;
  frameEncodeCached: boolean;
}

export interface SegmentationCandidate {
  data: Uint8Array;
  score: number;
}

export interface SegmentationResult {
  width: number;
  height: number;
  candidates: SegmentationCandidate[];
  bestIndex: number;
  decodeMs: number;
  /** Portion of the image perimeter occupied by the chosen mask. */
  boundaryFraction: number;
}

interface SamImageProcessor {
  reshape_input_points(
    points: number[][][][],
    originalSizes: [number, number][],
    reshapedInputSizes: [number, number][],
  ): Tensor;
  add_input_labels(labels: number[][][], points: Tensor): Tensor;
  post_process_masks(
    masks: Tensor,
    originalSizes: [number, number][],
    reshapedInputSizes: [number, number][],
  ): Promise<Tensor[]>;
}

interface LoadedSegmenter {
  model: {
    get_image_embeddings(inputs: { pixel_values: Tensor }): Promise<{
      image_embeddings: Tensor;
      image_positional_embeddings: Tensor;
    }>;
    _call(inputs: Record<string, Tensor>): Promise<{ pred_masks: Tensor; iou_scores: Tensor }>;
  };
  processor: {
    _call(image: unknown): Promise<{
      pixel_values: Tensor;
      original_sizes: [number, number][];
      reshaped_input_sizes: [number, number][];
    }>;
    image_processor?: SamImageProcessor;
  };
  RawImage: {
    read(input: string): Promise<unknown>;
  };
  loadMs: number;
}

interface CachedFrame extends PreparedSegmentationFrame {
  embeddings: {
    image_embeddings: Tensor;
    image_positional_embeddings: Tensor;
  };
  originalSizes: [number, number][];
  reshapedInputSizes: [number, number][];
}

let segmenterPromise: Promise<LoadedSegmenter> | undefined;
let cachedFrame: CachedFrame | undefined;

function requireWebGpu(): void {
  if (!("gpu" in navigator)) {
    throw new Error("Automatic selection needs WebGPU. Brush selection is still available in this browser.");
  }
}

async function loadSegmenter(onProgress?: (progress: SegmenterProgress) => void): Promise<LoadedSegmenter> {
  requireWebGpu();
  if (!segmenterPromise) {
    segmenterPromise = (async () => {
      const started = performance.now();
      const { AutoProcessor, RawImage, SamModel } = await import("@huggingface/transformers");
      const progressCallback = (event: { status: string; progress?: number; file?: string }) => {
        if (event.status === "progress") {
          onProgress?.({ phase: "loading", percent: event.progress, detail: event.file });
        }
      };
      onProgress?.({ phase: "loading", percent: 0, detail: "SlimSAM" });
      const [rawModel, rawProcessor] = await Promise.all([
        SamModel.from_pretrained(SEGMENTATION_MODEL_ID, {
          revision: SEGMENTATION_MODEL_REVISION,
          device: "webgpu",
          dtype: "fp16",
          progress_callback: progressCallback,
        }),
        AutoProcessor.from_pretrained(SEGMENTATION_MODEL_ID, {
          revision: SEGMENTATION_MODEL_REVISION,
          progress_callback: progressCallback,
        }),
      ]);
      const model = rawModel as unknown as LoadedSegmenter["model"];
      const processor = rawProcessor as unknown as LoadedSegmenter["processor"];
      if (!processor.image_processor) throw new Error("SlimSAM processor has no image processor");
      return { model, processor, RawImage, loadMs: performance.now() - started };
    })().catch((reason) => {
      segmenterPromise = undefined;
      throw reason;
    });
  }
  return segmenterPromise;
}

/** Load the pinned model and cache one frame's expensive image embedding. */
export async function prepareSegmentationFrame(
  imageUrl: string,
  onProgress?: (progress: SegmenterProgress) => void,
): Promise<PreparedSegmentationFrame> {
  if (cachedFrame?.imageUrl === imageUrl) {
    onProgress?.({ phase: "ready" });
    return {
      ...cachedFrame,
      modelLoadMs: 0,
      modelLoadCached: true,
      frameEncodeMs: 0,
      frameEncodeCached: true,
    };
  }

  const modelLoadCached = segmenterPromise !== undefined;
  const runtime = await loadSegmenter(onProgress);
  onProgress?.({ phase: "encoding", detail: "encoding this frame" });
  const started = performance.now();
  const rawImage = await runtime.RawImage.read(imageUrl);
  const inputs = await runtime.processor._call(rawImage);
  const embeddings = await runtime.model.get_image_embeddings({ pixel_values: inputs.pixel_values });
  const [height, width] = inputs.original_sizes[0];
  cachedFrame = {
    imageUrl,
    width,
    height,
    modelLoadMs: modelLoadCached ? 0 : runtime.loadMs,
    modelLoadCached,
    frameEncodeMs: performance.now() - started,
    frameEncodeCached: false,
    embeddings,
    originalSizes: inputs.original_sizes,
    reshapedInputSizes: inputs.reshaped_input_sizes,
  };
  onProgress?.({ phase: "ready" });
  return cachedFrame;
}

function boundaryFraction(data: Uint8Array, width: number, height: number): number {
  if (width < 2 || height < 2) return data.some(Boolean) ? 1 : 0;
  let selected = 0;
  for (let x = 0; x < width; x++) {
    selected += data[x] ? 1 : 0;
    selected += data[(height - 1) * width + x] ? 1 : 0;
  }
  for (let y = 1; y < height - 1; y++) {
    selected += data[y * width] ? 1 : 0;
    selected += data[y * width + width - 1] ? 1 : 0;
  }
  return selected / (2 * width + 2 * height - 4);
}

/** Decode all three SAM candidates for a set of positive/negative clicks. */
export async function segmentPreparedFrame(
  prepared: PreparedSegmentationFrame,
  prompts: readonly SegmentPrompt[],
  onProgress?: (progress: SegmenterProgress) => void,
): Promise<SegmentationResult> {
  if (!prompts.some((prompt) => prompt.label === 1)) {
    throw new Error("Add at least one positive click on the object.");
  }
  if (!cachedFrame || cachedFrame.imageUrl !== prepared.imageUrl) {
    throw new Error("The segmentation frame is no longer prepared. Start automatic selection again.");
  }
  const runtime = await loadSegmenter(onProgress);
  const imageProcessor = runtime.processor.image_processor;
  if (!imageProcessor) throw new Error("SlimSAM processor has no image processor");

  onProgress?.({ phase: "decoding" });
  const started = performance.now();
  const points = prompts.map((prompt) => [
    Math.max(0, Math.min(prepared.width - 1, prompt.x * prepared.width)),
    Math.max(0, Math.min(prepared.height - 1, prompt.y * prepared.height)),
  ]);
  const labels = prompts.map((prompt) => prompt.label);
  const inputPoints = imageProcessor.reshape_input_points(
    [[points]],
    cachedFrame.originalSizes,
    cachedFrame.reshapedInputSizes,
  );
  const inputLabels = imageProcessor.add_input_labels([[labels]], inputPoints);
  const outputs = await runtime.model._call({
    ...cachedFrame.embeddings,
    input_points: inputPoints,
    input_labels: inputLabels,
  });
  const processed = await imageProcessor.post_process_masks(
    outputs.pred_masks,
    cachedFrame.originalSizes,
    cachedFrame.reshapedInputSizes,
  );
  const decodeMs = performance.now() - started;
  const tensor = processed[0];
  const candidateCount = outputs.iou_scores.data.length;
  const pixelCount = prepared.width * prepared.height;
  if (tensor.data.length !== candidateCount * pixelCount) {
    throw new Error("SlimSAM returned a mask with unexpected dimensions");
  }
  const scores = Array.from(outputs.iou_scores.data, Number);
  const candidates = scores.map((score, candidateIndex) => ({
    score,
    data: Uint8Array.from(
      tensor.data.slice(candidateIndex * pixelCount, (candidateIndex + 1) * pixelCount),
      Number,
    ),
  }));
  const bestIndex = scores.reduce(
    (best, score, index) => (score > scores[best] ? index : best),
    0,
  );
  onProgress?.({ phase: "ready" });
  return {
    width: prepared.width,
    height: prepared.height,
    candidates,
    bestIndex,
    decodeMs,
    boundaryFraction: boundaryFraction(candidates[bestIndex].data, prepared.width, prepared.height),
  };
}
