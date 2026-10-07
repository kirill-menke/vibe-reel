/* Build constants in Svelte sources, folded before the Svelte compiler sees them.
 *
 * Vite's `define` runs on the compiler's JS output, too late for Svelte's own
 * choices: it never folds a constant into its static template
 * (`<p>{__WEB__ ? 'a' : 'b'}</p>` compiles to an empty <p> plus a `textContent`
 * write even when the test is `false`), and `x = __WEB__ ? 'a' : 'b'` on a
 * `$state` gets the proxying `$.set(x, …, true)` a plain string doesn't. A
 * web-only wording in a shared phone component would therefore move the phone
 * bundle's bytes. This pre-transform, on *.svelte sources that mention a name:
 *
 *   - turns markup `{NAME ? '…' : '…'}` (two plain string literals) into the
 *     chosen text, so the markup is exactly what it would be without the branch;
 *   - turns an expression `NAME ? '…' : '…'` into the chosen literal where the
 *     context makes that safe (after `=`, `=>`, `(`, `,`, `:`, `?`, `[`, `{` or
 *     `return`; before `;`, `)`, `,`, `]`, `}` or a line end);
 *   - replaces every other NAME with its literal value.
 *
 *   plugins: [svelteConsts({ __WEB__: false }), svelte(...)]   // phone build
 *
 * Used by phone/vite.config.js (`__WEB__` false) and web/vite.config.js (true);
 * the TV's components don't use `__WEB__`. */

/** @param {Record<string, boolean>} consts */
export function svelteConsts(consts) {
  const names = Object.keys(consts);
  const any = new RegExp('\\b(' + names.join('|') + ')\\b');
  const lit = String.raw`'([^'\\\n]*)'`;
  const before = String.raw`(?<=(?:[(,:[{]|(?<!\?)\?|(?<![=!<>])=|=>|\breturn)\s*)`;
  return {
    name: 'svelte-consts',
    enforce: /** @type {const} */ ('pre'),
    /** @param {string} code @param {string} id */
    transform(code, id) {
      if (!/\.svelte$/.test(id.split('?')[0]) || id.includes('?') || !any.test(code)) return null;
      let out = code;
      for (const name of names) {
        const on = consts[name];
        // `${NAME ? …}` (a template literal) and `attr={NAME ? …}` are expressions: next pass
        const markup = new RegExp(String.raw`(?<![$=])\{\s*${name}\s*\?\s*${lit}\s*:\s*${lit}\s*\}`, 'g');
        out = out.replace(markup, (_, a, b) => {
          const text = on ? a : b;
          if (/[<>&{}]/.test(text)) this.error(`svelte-consts: "${text}" in ${id} is not plain text; write the branch as an expression`);
          return text;
        });
        const expr = new RegExp(String.raw`${before}\b${name}\s*\?\s*${lit}\s*:\s*${lit}(?=\s*(?:[;),\]}]|$))`, 'gm');
        out = out.replace(expr, (_, a, b) => "'" + (on ? a : b) + "'");
        out = out.replace(new RegExp('\\b' + name + '\\b', 'g'), String(on));
      }
      return { code: out, map: null };
    }
  };
}
