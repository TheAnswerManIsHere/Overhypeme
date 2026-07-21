-- PR-A (NB2 prompt restructure, rev 7 plan §14): trim the global look_styles
-- copy for the 18 named styles to medium/technique + constitutive attributes
-- only (scene content belongs to the visual concept, not the style). Every new
-- value is <= 180 chars, restoring RENDER_STYLE_COPY_MAX_CHARS to its honest
-- bound and keeping the compiler's RENDER STYLE budget reserve provable.
--
-- PER-COLUMN GUARDED: each UPDATE fires ONLY where the column still equals that
-- style's exact old shipped value, so a column an admin customized is never
-- overwritten (and its sibling column can still update independently).
-- `none` is untouched (empty suffixes stay empty). Idempotent: re-running
-- matches nothing once applied. Rollback = swap new<->old in each WHERE/SET.

-- cinematic
UPDATE "look_styles" SET "prompt_suffix" = 'Rendered in cinematic film style: the look of a widescreen movie still with filmic color grading, volumetric lighting, and subtle lens flare.' WHERE "id" = 'cinematic' AND "prompt_suffix" = 'Rendered in a dramatic cinematic style with deep shadows, volumetric lighting, lens flare, and a dark moody color palette with warm orange and amber highlights. Composition resembles a widescreen movie still.';
UPDATE "look_styles" SET "prompt_suffix_reference" = 'Reimagine this scene in cinematic film style: the look of a widescreen movie still with filmic color grading, volumetric lighting, and subtle lens flare.' WHERE "id" = 'cinematic' AND "prompt_suffix_reference" = 'Reimagine this scene in a dramatic cinematic style with deep shadows, volumetric lighting, lens flare, and a dark moody color palette with warm orange and amber highlights. Composition resembles a widescreen movie still.';

-- epic
UPDATE "look_styles" SET "prompt_suffix" = 'Depicted in epic mythological painting style: Renaissance-inspired composition with baroque intensity, dramatic scale, and grand painterly lighting.' WHERE "id" = 'epic' AND "prompt_suffix" = 'Depicted as an epic mythological scene with divine lighting breaking through storm clouds, dramatic scale, and a sense of legendary power. Renaissance composition with baroque intensity.';
UPDATE "look_styles" SET "prompt_suffix_reference" = 'Transform this into epic mythological painting style: Renaissance-inspired composition with baroque intensity, dramatic scale, and grand painterly lighting.' WHERE "id" = 'epic' AND "prompt_suffix_reference" = 'Transform this into an epic mythological scene with divine lighting breaking through storm clouds, dramatic scale, and a sense of legendary power. Renaissance composition with baroque intensity.';

-- anime
UPDATE "look_styles" SET "prompt_suffix" = 'Illustrated in detailed Japanese anime style: bold outlines, cel-shaded rendering, expressive features, and vibrant color saturation.' WHERE "id" = 'anime' AND "prompt_suffix" = 'Illustrated in detailed Japanese anime style with dynamic action lines, expressive features, vibrant color saturation, and dramatic shading. Bold outlines with cel-shaded rendering.';
UPDATE "look_styles" SET "prompt_suffix_reference" = 'Reimagine this person/scene in detailed Japanese anime style: bold outlines, cel-shaded rendering, expressive features, and vibrant color saturation.' WHERE "id" = 'anime' AND "prompt_suffix_reference" = 'Reimagine this person/scene in detailed Japanese anime style with dynamic action lines, expressive features, vibrant color saturation, and dramatic shading. Bold outlines with cel-shaded rendering.';

-- comic
UPDATE "look_styles" SET "prompt_suffix" = 'Drawn in bold American comic book style: heavy black ink outlines, halftone dot shading, vivid flat colors, and dramatic foreshortening.' WHERE "id" = 'comic' AND "prompt_suffix" = 'Drawn in bold American comic book style with heavy black ink outlines, dynamic perspective, halftone dot shading, vivid flat colors, and dramatic foreshortening. Speech-bubble-ready composition.';
UPDATE "look_styles" SET "prompt_suffix_reference" = 'Transform this into bold American comic book style: heavy black ink outlines, halftone dot shading, vivid flat colors, and dramatic foreshortening.' WHERE "id" = 'comic' AND "prompt_suffix_reference" = 'Transform this into bold American comic book style with heavy black ink outlines, dynamic perspective, halftone dot shading, vivid flat colors, and dramatic foreshortening.';

-- cyberpunk
UPDATE "look_styles" SET "prompt_suffix" = 'Rendered in a cyberpunk aesthetic: neon-accented lighting treatment in magenta and cyan, high-contrast reflective surfaces, and a gritty high-tech finish.' WHERE "id" = 'cyberpunk' AND "prompt_suffix" = 'Rendered in a cyberpunk aesthetic with neon-soaked lighting in magenta and cyan, rain-slicked reflective surfaces, holographic elements, and a gritty dystopian urban atmosphere.';
UPDATE "look_styles" SET "prompt_suffix_reference" = 'Reimagine this scene in a cyberpunk aesthetic: neon-accented lighting treatment in magenta and cyan, high-contrast reflective surfaces, and a gritty high-tech finish.' WHERE "id" = 'cyberpunk' AND "prompt_suffix_reference" = 'Reimagine this scene in a cyberpunk aesthetic with neon-soaked lighting in magenta and cyan, rain-slicked reflective surfaces, holographic elements, and a gritty dystopian urban atmosphere.';

-- pixel-art
UPDATE "look_styles" SET "prompt_suffix" = 'Created as detailed 32-bit pixel art: clean sprite work, a limited color palette, visible pixel grid, and a retro video game look.' WHERE "id" = 'pixel-art' AND "prompt_suffix" = 'Created as detailed 32-bit pixel art with clean sprite work, limited color palette, visible pixel grid, and retro video game aesthetic reminiscent of classic arcade games.';
UPDATE "look_styles" SET "prompt_suffix_reference" = 'Reimagine this as detailed 32-bit pixel art: clean sprite work, a limited color palette, visible pixel grid, and a retro video game look.' WHERE "id" = 'pixel-art' AND "prompt_suffix_reference" = 'Reimagine this as detailed 32-bit pixel art with clean sprite work, limited color palette, visible pixel grid, and retro video game aesthetic reminiscent of classic arcade games.';

-- oil-painting
UPDATE "look_styles" SET "prompt_suffix" = 'Rendered as a classical oil painting: visible brushstrokes, rich impasto texture, and Rembrandt-style chiaroscuro.' WHERE "id" = 'oil-painting' AND "prompt_suffix" = 'Rendered as a classical oil painting with visible brushstrokes, rich impasto texture, Rembrandt-style chiaroscuro lighting, and the gravitas of a museum masterpiece.';
UPDATE "look_styles" SET "prompt_suffix_reference" = 'Transform this into a classical oil painting: visible brushstrokes, rich impasto texture, and Rembrandt-style chiaroscuro.' WHERE "id" = 'oil-painting' AND "prompt_suffix_reference" = 'Transform this into a classical oil painting with visible brushstrokes, rich impasto texture, Rembrandt-style chiaroscuro lighting, and the gravitas of a museum masterpiece.';

-- propaganda
UPDATE "look_styles" SET "prompt_suffix" = 'Designed as a bold Soviet-era propaganda poster: flat limited palette of red, black, cream, and gold, strong geometric composition, and blocky stylized figures.' WHERE "id" = 'propaganda' AND "prompt_suffix" = 'Designed as a bold Soviet-era propaganda poster with limited flat color palette of red, black, cream, and gold. Strong geometric composition, heroic upward angles, and blocky stylized figures.';
UPDATE "look_styles" SET "prompt_suffix_reference" = 'Reimagine this as a bold Soviet-era propaganda poster: flat limited palette of red, black, cream, and gold, strong geometric composition, and blocky stylized figures.' WHERE "id" = 'propaganda' AND "prompt_suffix_reference" = 'Reimagine this as a bold Soviet-era propaganda poster with limited flat color palette of red, black, cream, and gold. Strong geometric composition, heroic upward angles, and blocky stylized figures.';

-- pop-art
UPDATE "look_styles" SET "prompt_suffix" = 'Illustrated in Warhol-inspired pop art style: bold primary colors, Ben-Day dots, thick black outlines, and flat graphic shapes.' WHERE "id" = 'pop-art' AND "prompt_suffix" = 'Illustrated in Andy Warhol-inspired pop art style with bold primary colors, Ben-Day dots, thick black outlines, flat graphic shapes, and high-contrast repetition.';
UPDATE "look_styles" SET "prompt_suffix_reference" = 'Transform this into Warhol-inspired pop art style: bold primary colors, Ben-Day dots, thick black outlines, and flat graphic shapes.' WHERE "id" = 'pop-art' AND "prompt_suffix_reference" = 'Transform this into Andy Warhol-inspired pop art style with bold primary colors, Ben-Day dots, thick black outlines, flat graphic shapes, and high-contrast repetition.';

-- watercolor
UPDATE "look_styles" SET "prompt_suffix" = 'Painted in loose expressive watercolor: soft wet-on-wet color bleeds, visible paper texture, delicate washes, and intentional white space.' WHERE "id" = 'watercolor' AND "prompt_suffix" = 'Painted in loose expressive watercolor style with soft wet-on-wet color bleeds, visible paper texture, delicate washes, and areas of intentional white space where the paper shows through.';
UPDATE "look_styles" SET "prompt_suffix_reference" = 'Reimagine this in loose expressive watercolor: soft wet-on-wet color bleeds, visible paper texture, delicate washes, and intentional white space.' WHERE "id" = 'watercolor' AND "prompt_suffix_reference" = 'Reimagine this in loose expressive watercolor style with soft wet-on-wet color bleeds, visible paper texture, delicate washes, and areas of intentional white space where the paper shows through.';

-- photorealistic
UPDATE "look_styles" SET "prompt_suffix" = 'Rendered as a hyper-photorealistic photograph: true-to-life materials and textures, realistic optical detail, and high-end camera clarity.' WHERE "id" = 'photorealistic' AND "prompt_suffix" = 'Rendered as a hyper-photorealistic image with natural lighting, accurate material textures, shallow depth of field, and the quality of a high-end DSLR photograph.';
UPDATE "look_styles" SET "prompt_suffix_reference" = 'Reimagine this as a hyper-photorealistic photograph: true-to-life materials and textures, realistic optical detail, and high-end camera clarity.' WHERE "id" = 'photorealistic' AND "prompt_suffix_reference" = 'Reimagine this as a hyper-photorealistic image with natural lighting, accurate material textures, shallow depth of field, and the quality of a high-end DSLR photograph.';

-- graffiti
UPDATE "look_styles" SET "prompt_suffix" = 'Created as vibrant street art: spray-paint textures with drips, stencil layers, and bold graphic energy on a weathered concrete-wall surface.' WHERE "id" = 'graffiti' AND "prompt_suffix" = 'Created as vibrant street art on a weathered concrete wall with spray paint drips, stencil layers, bold tagging elements, and a raw urban energy. Mixed media collage feel.';
UPDATE "look_styles" SET "prompt_suffix_reference" = 'Transform this into vibrant street art: spray-paint textures with drips, stencil layers, and bold graphic energy on a weathered concrete-wall surface.' WHERE "id" = 'graffiti' AND "prompt_suffix_reference" = 'Transform this into vibrant street art on a weathered concrete wall with spray paint drips, stencil layers, bold tagging elements, and a raw urban energy. Mixed media collage feel.';

-- sketch
UPDATE "look_styles" SET "prompt_suffix" = 'Drawn as a detailed technical pencil sketch on aged parchment: cross-hatching, visible construction lines, and inventor''s-notebook draftsmanship.' WHERE "id" = 'sketch' AND "prompt_suffix" = 'Drawn as a detailed technical pencil sketch on aged parchment with cross-hatching, construction lines, annotated measurements, and the feel of a genius inventor''s notebook.';
UPDATE "look_styles" SET "prompt_suffix_reference" = 'Reimagine this as a detailed technical pencil sketch on aged parchment: cross-hatching, visible construction lines, and inventor''s-notebook draftsmanship.' WHERE "id" = 'sketch' AND "prompt_suffix_reference" = 'Reimagine this as a detailed technical pencil sketch on aged parchment with cross-hatching, construction lines, annotated measurements, and the feel of a genius inventor''s notebook.';

-- pulp-fiction
UPDATE "look_styles" SET "prompt_suffix" = 'Illustrated in 1950s pulp magazine cover style: painted texture, saturated lurid color treatment, and melodramatic vintage illustration flair.' WHERE "id" = 'pulp-fiction' AND "prompt_suffix" = 'Illustrated in 1950s pulp fiction magazine cover style with exaggerated dramatic poses, saturated lurid colors, painted texture, and sensational vintage typography framing.';
UPDATE "look_styles" SET "prompt_suffix_reference" = 'Transform this into 1950s pulp magazine cover style: painted texture, saturated lurid color treatment, and melodramatic vintage illustration flair.' WHERE "id" = 'pulp-fiction' AND "prompt_suffix_reference" = 'Transform this into a 1950s pulp fiction magazine cover style with exaggerated dramatic poses, saturated lurid colors, painted texture, and sensational vintage typography framing.';

-- stained-glass
UPDATE "look_styles" SET "prompt_suffix" = 'Depicted as an ornate stained glass window: bold black leading lines, jewel-tone translucent glass segments, and radiant backlighting.' WHERE "id" = 'stained-glass' AND "prompt_suffix" = 'Depicted as an ornate cathedral stained glass window with bold black leading lines, jewel-tone translucent color segments, radiant backlighting, and gothic architectural framing.';
UPDATE "look_styles" SET "prompt_suffix_reference" = 'Reimagine this as an ornate stained glass window: bold black leading lines, jewel-tone translucent glass segments, and radiant backlighting.' WHERE "id" = 'stained-glass' AND "prompt_suffix_reference" = 'Reimagine this as an ornate cathedral stained glass window with bold black leading lines, jewel-tone translucent color segments, radiant backlighting, and gothic architectural framing.';

-- claymation
UPDATE "look_styles" SET "prompt_suffix" = 'Rendered as stop-motion claymation: visible fingerprint textures in clay, slightly imperfect sculpted forms, and a miniature practical-set look.' WHERE "id" = 'claymation' AND "prompt_suffix" = 'Rendered to look like a stop-motion claymation scene with visible fingerprint textures on clay surfaces, slightly imperfect sculpted forms, miniature set design, and soft directional studio lighting.';
UPDATE "look_styles" SET "prompt_suffix_reference" = 'Reimagine this as stop-motion claymation: visible fingerprint textures in clay, slightly imperfect sculpted forms, and a miniature practical-set look.' WHERE "id" = 'claymation' AND "prompt_suffix_reference" = 'Reimagine this as a stop-motion claymation scene with visible fingerprint textures on clay surfaces, slightly imperfect sculpted forms, miniature set design, and soft directional studio lighting.';

-- ukiyo-e
UPDATE "look_styles" SET "prompt_suffix" = 'Illustrated in traditional Japanese ukiyo-e woodblock style: flat color areas, bold flowing outlines, woodblock print texture, and a muted natural pigment palette.' WHERE "id" = 'ukiyo-e' AND "prompt_suffix" = 'Illustrated in traditional Japanese ukiyo-e woodblock print style with flat color areas, bold flowing outlines, stylized wave and cloud motifs, and a muted natural pigment palette.';
UPDATE "look_styles" SET "prompt_suffix_reference" = 'Reimagine this in traditional Japanese ukiyo-e woodblock style: flat color areas, bold flowing outlines, woodblock print texture, and a muted natural pigment palette.' WHERE "id" = 'ukiyo-e' AND "prompt_suffix_reference" = 'Reimagine this in traditional Japanese ukiyo-e woodblock print style with flat color areas, bold flowing outlines, stylized wave and cloud motifs, and a muted natural pigment palette.';

-- neon-noir
UPDATE "look_styles" SET "prompt_suffix" = 'Rendered in neon noir style: deep black shadows cut by neon glow accents, film grain, and a moody high-contrast noir treatment.' WHERE "id" = 'neon-noir' AND "prompt_suffix" = 'Rendered in neon noir style with a rain-drenched nighttime setting, deep black shadows pierced only by harsh neon signage reflections, film grain, and a moody detective-thriller atmosphere.';
UPDATE "look_styles" SET "prompt_suffix_reference" = 'Reimagine this scene in neon noir style: deep black shadows cut by neon glow accents, film grain, and a moody high-contrast noir treatment.' WHERE "id" = 'neon-noir' AND "prompt_suffix_reference" = 'Reimagine this scene in neon noir style with a rain-drenched nighttime setting, deep black shadows pierced only by harsh neon signage reflections, film grain, and a moody detective-thriller atmosphere.';

