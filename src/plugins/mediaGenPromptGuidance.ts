/**
 * Professional prompt-rewrite guidance for media generation tools.
 * Adapted from Qwen/QianWen image & video skill prompt guides (inlined — no
 * dependency on external skill paths).
 */

export const DEFAULT_IMAGE_NEGATIVE_PROMPT =
  'low quality, blurry, distorted, deformed, bad anatomy, extra limbs, watermark, text, signature, out of frame, cropped';

export const DEFAULT_VIDEO_NEGATIVE_PROMPT =
  'low quality, blurry, distorted, watermark, static, frozen, jittery, inconsistent lighting, flickering';

export const IMAGE_GEN_PROMPT_GUIDANCE = `PROMPT REWRITE (required):
The \`prompt\` argument must be a professional image-generation prompt — NOT a verbatim short user utterance (unless the user already supplied a complete professional prompt; then use it with only light completion of missing dimensions).

Formulas (from Qwen Image skill):
- Basic: Entity + Environment + Style
- Advanced (default target): Entity(details) + Environment(details) + Style + Camera Language + Atmosphere + Detail Modifiers

Cover: subject details, setting, lighting (golden hour / rim light / studio), shot size (close-up / medium / long), perspective (eye level / low angle), lens (85mm / wide), style keywords (realistic / watercolor / C4D / Pixar / Chinese ink), quality modifiers (sharp focus, 8K).
For posters or on-image text: explicitly state the exact wording and layout position.
Optional \`negativePrompt\`: exclude unwanted elements. Default when user is silent: "${DEFAULT_IMAGE_NEGATIVE_PROMPT}".
Optional \`userIntent\`: short original user wording for audit only — never sent to the provider API.
DashScope \`promptExtend\`: true for short prompts (<~30 words), false when the advanced formula is already fully specified.`;

export const VIDEO_GEN_PROMPT_GUIDANCE = `PROMPT REWRITE (required):
The \`prompt\` argument must be a professional video-generation prompt — NOT a verbatim short user utterance (unless the user already supplied a complete professional prompt).

t2v formula (Qwen/Wan skill): Entity + Scene + Motion + Aesthetic control + Stylization.
Weak prompts often miss aesthetics and camera moves — always enrich those dimensions.
i2v (when \`imagePath\` is set): focus on Motion + Camera Movement (+ Sound); the image defines entity/scene/style.

Camera dictionary: camera pushes in / pulls out / moves left / orbiting / fixed camera; speed: slowly / quickly / gently.
Multi-shot narrative (longer clips): overall theme line, then:
  Shot 1 [0–Xs]: shot size, camera, lighting, action, dialogue, sound
  Shot 2 [X–Ys]: ...
Optional sound (when the model supports audio): Voice / SFX / BGM descriptions.
Optional \`negativePrompt\` default: "${DEFAULT_VIDEO_NEGATIVE_PROMPT}".
Optional \`userIntent\`: audit only — not sent to the API.
DashScope/HappyHorse \`promptExtend\`: true for short prompts or multi-shot that needs vendor rewrite; false for fully specified advanced prompts.`;

export const MESH_GEN_PROMPT_GUIDANCE = `PROMPT REWRITE (required):
The \`prompt\` argument must be a professional text-to-3D prompt — NOT a vague short utterance (unless the user already gave a complete modeling brief).

Formula: Subject (geometry & parts) + Materials/PBR + Scale/use-case + Topology intent (lowpoly / game-ready / organic) + Style.
Emphasize a single modelable object, closed mesh, material regions; for characters specify pose and clothing layers.
Avoid cinematic multi-shot prose — prefer sculptable object language.
Optional \`userIntent\`: audit only — not sent to the API.`;

export function formatAvailableProfilesPrompt(
  profiles: Array<{ id: string; label?: string; provider: string; model: string }>,
  defaultProfileId?: string,
): string {
  if (profiles.length === 0) {
    return 'No generation profiles are configured. Ask the user to add API keys in Customize → Plugins.';
  }
  const lines = profiles.map(profile => {
    const label = profile.label?.trim() || profile.id;
    const mark = defaultProfileId && profile.id === defaultProfileId ? ' (default)' : '';
    return `- id="${profile.id}" label="${label}" provider=${profile.provider} model=${profile.model}${mark}`;
  });
  return `Available profiles (pass \`profile\` as id, label, or model; omit to use default):\n${lines.join('\n')}`;
}
