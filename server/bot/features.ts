/** Loaded modules register their public contract once, beside their implementation. */
export type FeatureState = 'available' | 'disabled' | 'command_only' | 'automatic' | 'needs_permission' | 'needs_binding' | 'unknown';
export interface PublicFeature {
  id: string;
  description: string;
  trigger: 'automatic' | 'conversation';
  visibility: 'public';
  state: (db: any, event: any) => FeatureState;
}
const features = new Map<string, PublicFeature>();
export function registerPublicFeature(feature: PublicFeature) {
  if (!/^[a-z][a-z0-9_.-]{1,70}$/.test(feature.id) || !feature.description.trim()
    || feature.visibility !== 'public' || typeof feature.state !== 'function') throw new Error('Invalid public feature contract');
  if (features.has(feature.id)) throw new Error('Duplicate public feature: ' + feature.id);
  features.set(feature.id, Object.freeze(feature));
}
export function registeredPublicFeatures(): readonly PublicFeature[] { return [...features.values()]; }
