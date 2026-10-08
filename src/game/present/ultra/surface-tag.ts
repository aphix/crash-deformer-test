import type * as THREE from "three";

/** The ground surfaces Ultra has photographic (PBR) textures for. */
export type SurfaceRole = "asphalt" | "concrete" | "ground";

/** What a procedural surface texture is: its role, and the world metres one UV unit spans where it is mapped (the course's tile, the stage disc's diameter). */
export type SurfaceTag = { role: SurfaceRole; uvMetres: number };

/** Mark `tex` as a surface Ultra can swap for a PBR set (it is static and tiny: the Ultra chunk reads the mark, nothing here loads it). */
export function tagSurface<T extends THREE.Texture>(tex: T, role: SurfaceRole, uvMetres: number): T {
  const tag: SurfaceTag = { role, uvMetres };
  tex.userData.surface = tag;
  return tex;
}

export function surfaceOf(tex: THREE.Texture): SurfaceTag | null {
  return (tex.userData.surface as SurfaceTag | undefined) ?? null;
}
