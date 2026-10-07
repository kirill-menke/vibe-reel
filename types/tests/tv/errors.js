/* Type test: VR.ApiError is what the fetch layers throw (api.js, medialib.js, segfeed.js,
 * livefeed.js) and what errText() / catch sites read. */
import { errText } from '../../../src/lib/api.js';

/** @type {VR.ApiError} */
const e = Object.assign(new Error('HTTP 503'), { status: 503, code: 'temporarily_unavailable', retriable: true, retryAfter: 60 });
/** @type {string} */
export const shown = errText(e);
export const fromNull = errText(null);

/** @type {TypeTest.Assert<TypeTest.Not<TypeTest.IsAny<VR.ApiError['status']>>>} */
export const statusNotAny = true;
/** An ApiError is still an Error (instanceof checks, `.name === 'AbortError'`). */
/** @type {Error} */
export const isError = e;

// @ts-expect-error status is a number (0 = no HTTP answer), not a string.
/** @type {VR.ApiError} */ export const badStatus = Object.assign(new Error('x'), { status: '503' });
// @ts-expect-error 'retry' is not a field: the flag is `retriable` (medialib.js).
export const typo = e.retry;
