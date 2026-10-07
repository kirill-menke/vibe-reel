/* Type-level assertion helpers for types/tests/**. A test is a JSDoc-typed constant:
 *   /** @type {TypeTest.Assert<TypeTest.SameKeys<A, B>>} *\/ const ok = true;
 * fails to type-check (→ svelte-check error → lane check fails) when the claim is false.
 * Negative claims use `// @ts-expect-error <reason>` on the line before. */
declare namespace TypeTest {
  /** Accepts only `true`. */
  type Assert<T extends true> = T;
  /** true when A and B have exactly the same property names. */
  type SameKeys<A, B> = [keyof A] extends [keyof B] ? ([keyof B] extends [keyof A] ? true : false) : false;
  /** true when every property name of A is also one of B. */
  type KeysSubset<A, B> = [keyof A] extends [keyof B] ? true : false;
  /** true when T is `any` (used to prove a type is NOT any: Assert<Not<IsAny<T>>>). */
  type IsAny<T> = 0 extends 1 & T ? true : false;
  type Not<T extends boolean> = T extends true ? false : true;
  /** true when A and B are mutually assignable (used for exact unions of key names). */
  type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
}
