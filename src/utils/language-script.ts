const SCRIPT_OF: Array<[RegExp, RegExp]> = [
  [/^(ru|uk)-/, /\p{Script=Cyrillic}/u],
  [/^el-/, /\p{Script=Greek}/u],
  [/^ja-/, /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u],
  [/^ko-/, /\p{Script=Hangul}/u],
  [/^cmn-/, /\p{Script=Han}/u],
  [/^th-/, /\p{Script=Thai}/u],
  [/^ar-/, /\p{Script=Arabic}/u],
  [/^hi-/, /\p{Script=Devanagari}/u],
];

/** Whether a caption could be in the language: at least half its letters are in that language's script. Two Latin-script languages cannot be told apart this way, so English against German is always a fit. */
export function textFitsLanguage(text: string, lang: string): boolean {
  const script = SCRIPT_OF.find(([prefix]) => prefix.test(lang))?.[1] ?? /\p{Script=Latin}/u;
  let letters = 0;
  let own = 0;
  for (const ch of text) {
    if (!/\p{L}/u.test(ch)) continue;
    letters++;
    if (script.test(ch)) own++;
  }
  return letters === 0 || own * 2 >= letters;
}
