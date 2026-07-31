// Minimal .npz/.npy reader for DA3 outputs (float32 arrays, deflate or stored).
// Keeper utility: M2's local point-cloud processing parses result.npz with this.

export interface NpyArray {
  shape: number[];
  dtype: string;
  data: Float32Array;
}

const EOCD_SIG = 0x06054b50;
const CDIR_SIG = 0x02014b50;

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("deflate-raw");
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function parseNpy(bytes: Uint8Array): NpyArray {
  const magic = String.fromCharCode(...bytes.subarray(1, 6));
  if (bytes[0] !== 0x93 || magic !== "NUMPY") throw new Error("not an npy file");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const major = bytes[6];
  const headerLen = major >= 2 ? view.getUint32(8, true) : view.getUint16(8, true);
  const headerStart = major >= 2 ? 12 : 10;
  const header = new TextDecoder().decode(bytes.subarray(headerStart, headerStart + headerLen));
  const dtype = /'descr':\s*'([^']+)'/.exec(header)?.[1];
  const shapeMatch = /'shape':\s*\(([^)]*)\)/.exec(header)?.[1];
  if (!dtype || shapeMatch === undefined) throw new Error(`bad npy header: ${header}`);
  if (/'fortran_order':\s*True/.test(header)) throw new Error("fortran order unsupported");
  if (dtype !== "<f4") throw new Error(`unsupported dtype ${dtype} (only <f4)`);
  const shape = shapeMatch.split(",").map((s) => s.trim()).filter(Boolean).map(Number);
  const dataStart = headerStart + headerLen;
  const count = shape.reduce((a, b) => a * b, 1);
  // Copy to guarantee 4-byte alignment regardless of offset within the zip.
  const raw = bytes.slice(dataStart, dataStart + count * 4);
  return { shape, dtype, data: new Float32Array(raw.buffer, 0, count) };
}

/** Parse a .npz archive (zip of .npy files) into named arrays. */
export async function parseNpz(buffer: ArrayBuffer): Promise<Record<string, NpyArray>> {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);

  // Find end-of-central-directory record (scan back past any zip comment).
  let eocd = -1;
  for (let i = buffer.byteLength - 22; i >= Math.max(0, buffer.byteLength - 65558); i--) {
    if (view.getUint32(i, true) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip: EOCD not found");
  const entryCount = view.getUint16(eocd + 10, true);
  let off = view.getUint32(eocd + 16, true);

  const out: Record<string, NpyArray> = {};
  for (let i = 0; i < entryCount; i++) {
    if (view.getUint32(off, true) !== CDIR_SIG) throw new Error("bad central directory");
    const method = view.getUint16(off + 10, true);
    const compSize = view.getUint32(off + 20, true);
    const nameLen = view.getUint16(off + 28, true);
    const extraLen = view.getUint16(off + 30, true);
    const commentLen = view.getUint16(off + 32, true);
    const localOff = view.getUint32(off + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(off + 46, off + 46 + nameLen));

    // Local header's own name/extra lengths determine the data offset.
    const lNameLen = view.getUint16(localOff + 26, true);
    const lExtraLen = view.getUint16(localOff + 28, true);
    const dataOff = localOff + 30 + lNameLen + lExtraLen;
    const comp = bytes.subarray(dataOff, dataOff + compSize);
    const raw = method === 8 ? await inflateRaw(comp) : method === 0 ? comp : null;
    if (!raw) throw new Error(`unsupported zip method ${method}`);
    out[name.replace(/\.npy$/, "")] = parseNpy(raw);

    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** Percentile of a float array (nearest-rank), ignoring non-finite values. */
export function percentile(values: Float32Array, p: number): number {
  const finite = Array.from(values).filter(Number.isFinite);
  if (finite.length === 0) return NaN;
  finite.sort((a, b) => a - b);
  const idx = Math.min(finite.length - 1, Math.max(0, Math.ceil((p / 100) * finite.length) - 1));
  return finite[idx];
}
