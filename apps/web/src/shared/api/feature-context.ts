import type { Role } from '@sipges/contracts';

/** App composition supplies identity and authorized tenant; features never import each other. */
export type FeatureContext = {
  scope: string;
  projectId: string;
  projectLabel: string;
  role: Role;
  username: string;
  fullName: string;
};
