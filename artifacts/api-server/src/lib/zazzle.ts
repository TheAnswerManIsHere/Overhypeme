import { getConfigString } from "./adminConfig";

export interface ZazzleLinkOptions {
  imageUrl?: string;
  imageName?: string;
  returnUrl?: string;
}

export async function buildZazzleUrl(opts: ZazzleLinkOptions = {}): Promise<string> {
  const [at, rf, ax, sr, cg, ed, tc] = await Promise.all([
    getConfigString("zazzle_at", "238499514566968751"),
    getConfigString("zazzle_rf", "238499514566968751"),
    getConfigString("zazzle_ax", "DesignBlast"),
    getConfigString("zazzle_sr", ""),
    getConfigString("zazzle_cg", ""),
    getConfigString("zazzle_ed", "true"),
    getConfigString("zazzle_tc", ""),
  ]);

  const params = new URLSearchParams();
  params.set("rf", rf);
  params.set("ax", ax);
  if (sr) params.set("sr", sr);
  if (cg) params.set("cg", cg);
  params.set("ed", ed);
  if (opts.returnUrl) params.set("continueUrl", opts.returnUrl);
  if (tc) params.set("tc", tc);
  if (opts.imageName) params.set("ic", opts.imageName);
  if (opts.imageUrl) params.set("t_image1_iid", opts.imageUrl);

  return `https://www.zazzle.com/at-${at}?${params}`;
}
