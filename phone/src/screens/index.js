/* Route name → screen component. Every screen receives { params, active }:
 *   params  the Route's params (push(name, params))
 *   active  it is the visible top of the active tab and no modal covers it
 * A screen renders a fragment: its header (TopBar / NavBar, as a sibling) and
 * a `.screen` scroller; the route wrapper around it is position:absolute,
 * inset 0. Watch R.playerClosed (router.svelte.js) to refetch play state.
 *
 * Placeholders to overwrite (one file per screen, same name):
 *   Home.svelte, Settings.svelte                      — B (Home & account)
 *   Library.svelte (movies AND shows: params.type), Search.svelte, Chart.svelte
 *                                                     — C (Library & search)
 *   Detail.svelte (dispatches params.type → MovieDetail / SeriesDetail),
 *   Person.svelte, LookupDetail.svelte, PendingDetail.svelte — D (Title pages)
 * Adding a route: append one line here (allowed for every workstream). */
import Home from './Home.svelte';
import Library from './Library.svelte';
import Search from './Search.svelte';
import Chart from './Chart.svelte';
import Detail from './Detail.svelte';
import Person from './Person.svelte';
import LookupDetail from './LookupDetail.svelte';
import PendingDetail from './PendingDetail.svelte';
import Settings from './Settings.svelte';
import Downloads from './Downloads.svelte';
import MyLibrary from './MyLibrary.svelte';

export const screens = {
  home: Home,
  movies: Library,
  shows: Library,
  search: Search,
  chart: Chart,
  detail: Detail,
  person: Person,
  lookup: LookupDetail,
  pending: PendingDetail,
  settings: Settings,
  downloads: Downloads,
  mylibrary: MyLibrary
};
