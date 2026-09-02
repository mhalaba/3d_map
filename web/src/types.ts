export type LngLat = [number, number];

export type BBox = {
  west: number;
  south: number;
  east: number;
  north: number;
};

export type RoofShape =
  | 'flat'
  | 'gabled'
  | 'hipped'
  | 'pyramidal'
  | 'skillion'
  | 'dome'
  | 'round'
  | 'gambrel'
  | 'mansard'
  | 'onion';

export type BuildingTags = {
  height?: number;
  minHeight?: number;
  levels?: number;
  minLevel?: number;
  roofHeight?: number;
  roofLevels?: number;
  roofShape?: RoofShape;
  roofOrientation?: 'along' | 'across';
  roofDirection?: number;
  roofAngle?: number;
  name?: string;
  colour?: string;
};

export type BuildingFeature = {
  id: string;
  outer: LngLat[];
  holes: LngLat[][];
  tags: BuildingTags;
};

export type LocalPoint = { x: number; y: number };

export type ProjectedRing = LocalPoint[];

export type ProjectedBuilding = {
  id: string;
  outer: ProjectedRing;
  holes: ProjectedRing[];
  tags: BuildingTags;
  wallHeight: number;
  minHeight: number;
  roofHeight: number;
  roofShape: RoofShape;
};

export type Origin = {
  lng: number;
  lat: number;
};

export type ExportOptions = {
  /** map meters → millimeters (1:1000 => 1) */
  metersToMm: number;
  basePlateMm: number;
  binary: boolean;
  /** When true, `buildings` is already the export set (skip bbox filter). */
  prefiltered?: boolean;
};
