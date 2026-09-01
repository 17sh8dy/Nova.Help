/**
 * The project registry.
 *
 * This array is the whole of the homepage. Adding a product to Nova.Help means writing one
 * file next to this one and adding it here; removing one means deleting the import. Order in
 * this array is the order on screen.
 *
 * A project may carry `status: { label, tone, note }` when it is not generally available. The
 * cards and the ticket form both read it, so a product in alpha says so everywhere at once.
 *
 * Nova Launcher and the rest of the ecosystem are deliberately absent: a support portal that
 * offers a queue for a product nobody can file a real ticket against is worse than one that
 * does not list it.
 */
import { project as novaSite } from './nova-site.js';
import { project as onlineEarth } from './online-earth.js';
import { project as atlas } from './atlas.js';
import { project as openCut } from './open-cut.js';
import { project as novaEngine } from './nova-engine.js';
import { project as replayGg } from './replay-gg.js';

export const projects = [novaSite, onlineEarth, atlas, openCut, novaEngine, replayGg];
