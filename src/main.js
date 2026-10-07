import { mount } from 'svelte';
import './style.css';
import App from './App.svelte';
import { initLifecycle } from './lib/lifecycle.js';

// Before mount: the relaunch listener has to exist by the time webOS can fire it.
initLifecycle();

export default mount(App, { target: /** @type {HTMLElement} */ (document.getElementById('app')) });
