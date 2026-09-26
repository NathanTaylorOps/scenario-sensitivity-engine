import type { Persona } from "../engine/types.ts";
import { manufacturerPersona } from "./manufacturer.ts";
import { mineSiteServicesPersona } from "./mineSiteServices.ts";
import { shortStayAccommodationPersona } from "./shortStayAccommodation.ts";
import { softwareConsultancyPersona } from "./softwareConsultancy.ts";

/**
 * Every persona this engine ships with — the swappable registry the whole
 * driver-based architecture was built to support. Swapping a persona means
 * swapping which config from this array is active; the simulation engine
 * (src/engine/) never changes and has no per-persona branching in it.
 */
export const personas: Persona[] = [manufacturerPersona, mineSiteServicesPersona, shortStayAccommodationPersona, softwareConsultancyPersona];

export function findPersona(id: string): Persona | undefined {
  return personas.find((p) => p.id === id);
}

export { manufacturerPersona, mineSiteServicesPersona, shortStayAccommodationPersona, softwareConsultancyPersona };
