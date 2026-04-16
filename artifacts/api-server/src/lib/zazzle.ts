import { getConfigString } from "./adminConfig";

export interface ZazzleLinkOptions {
  imageUrl?: string;
  imageName?: string;
  returnUrl?: string;
}

export async function buildZazzleUrl(
  opts: ZazzleLinkOptions = {},
): Promise<string> {
  const [at, rf, ax, sr, cg, ed, tc] = await Promise.all([
    getConfigString("zazzle_at", ""),
    getConfigString("zazzle_rf", ""),
    getConfigString("zazzle_ax", ""),
    getConfigString("zazzle_sr", ""),
    getConfigString("zazzle_cg", ""),
    getConfigString("zazzle_ed", ""),
    getConfigString("zazzle_tc", ""),
  ]);

  const params = new URLSearchParams();
  params.set("at", at);
  params.set("rf", rf);
  params.set("ax", ax);
  params.set("sr", sr);
  if (cg) params.set("cg", cg);
  params.set("ed", ed);
  if (opts.returnUrl) params.set("continueUrl", opts.returnUrl);
  if (tc) params.set("tc", tc);
  if (opts.imageName) params.set("ic", opts.imageName);
  if (opts.imageUrl) params.set("t_image1_iid", opts.imageUrl);

  return `https://www.zazzle.com/at-${at}?${params}`;
}
