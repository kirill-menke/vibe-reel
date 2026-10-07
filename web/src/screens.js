/* Route name → screen component for the web build (the phone's registry,
 * phone/src/screens/index.js, minus Downloads — no offline copies on the
 * desktop — and with the web's own Settings). Every screen receives
 * { params, active }; see the phone registry for the contract. */
import Home from '$p/screens/Home.svelte';
import Library from '$p/screens/Library.svelte';
import Search from '$p/screens/Search.svelte';
import Chart from '$p/screens/Chart.svelte';
import Detail from '$p/screens/Detail.svelte';
import Person from '$p/screens/Person.svelte';
import LookupDetail from '$p/screens/LookupDetail.svelte';
import PendingDetail from '$p/screens/PendingDetail.svelte';
import MyLibrary from '$p/screens/MyLibrary.svelte';
import Settings from './screens/Settings.svelte';

/** @type {Partial<Record<VR.RouteName, import('svelte').Component<any>>>} */
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
  mylibrary: MyLibrary
};
