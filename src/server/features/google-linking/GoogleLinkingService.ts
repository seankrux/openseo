import { listGoogleProperties } from "./GooglePropertyDiscovery";

import { linkGa4, linkGsc } from "./GooglePropertyLinking";

import { autoLink } from "./GoogleAutoLink";

export const GoogleLinkingService = {
  listGoogleProperties,
  linkGsc,
  linkGa4,
  autoLink,
};
