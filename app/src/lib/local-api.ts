/** Proof that a request came from the page Vite served for this dev session. */
const NONCE_META = "verge-dev-nonce";

export function localApiHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const nonce = document.querySelector(`meta[name="${NONCE_META}"]`)?.getAttribute("content");
  if (!nonce) throw new Error("local API nonce is unavailable; reload the dev server page");
  return { ...extra, "x-verge-dev-nonce": nonce };
}
