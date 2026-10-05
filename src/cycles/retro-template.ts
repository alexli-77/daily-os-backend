/**
 * The retro scaffold, copied from the shape the Feishu retro column has always
 * had: three emoji-led sections in a fixed order.
 *
 * This is not decoration. life-review-os parses a retro back out by looking for
 * exactly these headings — see `bin/life-review-os.mjs`, which splits on
 * `(?:😄\s*)?状态`, `(?:👍🏻?\s*)?做[得的]好` and `(?:💪🏻?\s*)?待改进` and feeds
 * the three pieces to the planner as the previous cycle's context. A retro
 * written in the UI without them still reads fine to a human but arrives at the
 * next planning run as one undifferentiated blob.
 *
 * The parser tolerates a missing emoji and either of 做得好 / 做的好; this
 * template picks the spelling the existing vault files use.
 */
export const RETRO_TEMPLATE = [
  '😄状态',
  '情绪：',
  '精力：',
  '外部压力：',
  '计划外吃掉时间的事：',
  '',
  '👍🏻做的好',
  '',
  '💪🏻待改进',
  '',
].join('\n');

/**
 * True when `value` is the untouched template.
 *
 * The UI pre-fills an empty retro with the scaffold, which would otherwise make
 * "never written" indistinguishable from "written and left blank" the moment
 * the text is saved. Compared with whitespace collapsed so a stray trailing
 * newline does not count as content.
 */
export function isBlankRetroTemplate(value: string): boolean {
  const normalize = (text: string) =>
    text
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map((line) => line.trim())
      .join('\n')
      .trim();
  return normalize(value) === normalize(RETRO_TEMPLATE);
}
