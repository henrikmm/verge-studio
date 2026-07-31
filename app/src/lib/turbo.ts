// Google Turbo colormap, polynomial approximation (Mikhailov 2019).
// t in [0,1] -> [r,g,b] in [0,255].
export function turbo(t: number): [number, number, number] {
  const x = Math.min(1, Math.max(0, t));
  const r = 34.61 + x * (1172.33 + x * (-10793.56 + x * (33300.12 + x * (-38394.49 + x * 14825.05))));
  const g = 23.31 + x * (557.33 + x * (1225.33 + x * (-3574.96 + x * (1073.77 + x * 707.56))));
  const b = 27.2 + x * (3211.1 + x * (-15327.97 + x * (27814.0 + x * (-22569.18 + x * 6838.66))));
  const clamp = (v: number) => Math.min(255, Math.max(0, Math.round(v)));
  return [clamp(r), clamp(g), clamp(b)];
}
