// Shared world data: critter sizes, fur colors, and night-walk spots.
// Size and fur color are what witnesses and crime scenes can reveal (never names, unless seen clearly)
const SIZE = { mouse: 'small', hamster: 'small', frog: 'small', duck: 'small', bunny: 'medium', cat: 'medium', fox: 'medium', raccoon: 'medium',
  bear: 'large', panda: 'large', pig: 'large', koala: 'large' };
const FUR = { berry: 'pink', honey: 'yellow', sky: 'blue', mint: 'mint', lilac: 'lilac', peach: 'orange', moss: 'green', cocoa: 'brown' };
// Night-walk spots. `trace` is what a culprit coming from there leaves at the scene.
const PLACES = {
  bakery: { name: 'Bakery', e: '🥖', trace: 'Flour was tracked onto the doorstep, like someone came from the Bakery.' },
  mill: { name: 'Mill', e: '🌾', trace: 'Bits of straw were scattered by the door, like someone came from the Mill.' },
  orchard: { name: 'Orchard', e: '🍎', trace: 'A squashed apple leaf was stuck to the doormat, like someone came from the Orchard.' },
  well: { name: 'Old Well', e: '🪣', trace: 'Wet mud was smeared on the step, like someone came from the Old Well.' },
  library: { name: 'Library', e: '📚', trace: 'A torn page was left on the path, like someone came from the Library.' },
  garden: { name: 'Garden', e: '🌻', trace: 'Sunflower petals were on the welcome mat, like someone came from the Garden.' },
};
module.exports = { SIZE, FUR, PLACES };
