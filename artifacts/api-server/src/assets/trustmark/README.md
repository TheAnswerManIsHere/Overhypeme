# TrustMark Q models (invisible watermark)

Adobe's TrustMark variant Q, as ONNX, exactly as Adobe publishes them for its
own JavaScript decoder. Used by `src/lib/provenance/watermark.ts` to mark every
composed meme with its provenance record id and to read that id back on the
admin Trace screen (plan `docs/plans/PLAN_IMAGE_TRACING.md`, increment 2).

| File | Source | sha256 |
|---|---|---|
| `encoder_Q.onnx` | https://cai-watermark.adobe.net/watermarking/trustmark-models/encoder_Q.onnx | `19b3d1b25836130ffd78775a8f61539f993375d1823ef0e59ba5b8dffb4f892d` |
| `decoder_Q.onnx` | https://cai-watermark.adobe.net/watermarking/trustmark-models/decoder_Q.onnx | `ee3268f057c9dabef680e169302f5973d0589feea86189ed229a896cc3aa88df` |

Licence: MIT (Adobe TrustMark, https://github.com/adobe/trustmark).

They are committed rather than downloaded at start-up so that a picture can be
traced years from now whether or not Adobe still hosts them; the code checks
each file's hash when it loads it and refuses a file that does not match.
