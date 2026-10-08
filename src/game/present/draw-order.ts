import type { Material, RenderItem } from "three";
import { drawClassOf } from "../vehicle/car-materials.ts";

/** three numbers every material at creation (`Material.id`) and its own sorts use it, but its types do not declare it. */
const idOf = (m: Material): number => (m as Material & { readonly id: number }).id;

/**
 * three's opaque draw order (group, renderOrder, material id, instancing, depth front to back, object id) with the material's draw
 * class between renderOrder and material id. Materials come out of the factories car by car, so by id alone the order runs
 * paint, trim, paint, trim ... and every switch is a `useProgram` plus the new program's texture rebinds (46 program switches for
 * 19 programs in a 32-car frame); by class it runs every paint draw, then every parts draw, then every trim draw.
 */
export function sortByDrawClass(a: RenderItem, b: RenderItem): number {
  if (a.groupOrder !== b.groupOrder) return a.groupOrder - b.groupOrder;
  if (a.renderOrder !== b.renderOrder) return a.renderOrder - b.renderOrder;
  const classA = drawClassOf(a.material);
  const classB = drawClassOf(b.material);
  if (classA !== classB) return classA - classB;
  if (idOf(a.material) !== idOf(b.material)) return idOf(a.material) - idOf(b.material);
  if (a.materialVariant !== b.materialVariant) return a.materialVariant - b.materialVariant;
  if (a.z !== b.z) return a.z - b.z;
  return a.id - b.id;
}
