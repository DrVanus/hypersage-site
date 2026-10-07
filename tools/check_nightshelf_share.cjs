// Exercise the actual scripts with only their small DOM surface stubbed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..', 'nightshelf');
const catalogSource = fs.readFileSync(path.join(root, 'shared-book-catalog.js'), 'utf8');
const versionedSource = fs.readFileSync(path.join(root, 'shared-book-versioned.js'), 'utf8');
const handler = fs.readFileSync(path.join(root, 'shared-book.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

function run(search) {
  const elements = Object.fromEntries([
    'shared-book', 'shared-book-title', 'shared-book-author',
    'shared-book-description', 'shared-book-edition', 'shared-book-open', 'shared-book-help',
  ].map(id => [id, { hidden: true, textContent: '', href: '' }]));
  const context = {
    URLSearchParams,
    window: { location: { search } },
    document: { title: 'Nightshelf', getElementById: id => elements[id] },
  };
  vm.createContext(context);
  vm.runInContext(catalogSource, context);
  vm.runInContext(versionedSource, context);
  vm.runInContext(handler, context);
  assert.equal(context.window.location.search, search, 'Must not navigate automatically');
  return { elements, context };
}

const catalog = run('').context.window.nightshelfSharedBooks;
for (const [id, book] of Object.entries(catalog)) {
  const { elements, context } = run('?book=' + encodeURIComponent(id));
  assert.equal(elements['shared-book'].hidden, false);
  assert.equal(elements['shared-book-title'].textContent, book.title);
  const original = book.kind === 'original';
  assert.equal(elements['shared-book-author'].textContent, original ? 'A Nightshelf Original' : 'by ' + book.author);
  if (original) {
    assert.match(book.disclosure, /Created with AI/, id + ' must carry the AI disclosure');
    assert.ok(elements['shared-book-description'].textContent.includes(book.disclosure), id + ' card must disclose AI');
  } else {
    assert.equal(elements['shared-book-description'].textContent, book.blurb);
  }
  assert.equal(elements['shared-book-open'].href, 'nightshelf://book/' + id);
  assert.equal(elements['shared-book-edition'].textContent,
    book.freeTier ? 'Free on Nightshelf' : 'Included with Nightshelf Pro');
  assert.equal(context.document.title, original
    ? book.title + ' — a Nightshelf Original'
    : book.title + ' by ' + book.author + ' — Nightshelf');
}
// Titles introduced in1.9.9 have explicit version-qualified cards. The released
// catalog remains separate and unchanged; the query never creates a URL itself.
const versioned = run('').context.window.nightshelfVersionedSharedBooks;
const expectedVersionedIDs = ["age_innocence", "anne_house_dreams", "anne_island", "beasts_super_beasts", "bedtime_aladdin", "bedtime_bremen_musicians", "bedtime_frog_prince", "bedtime_happy_prince", "bedtime_nightingale_rose", "bedtime_puss_in_boots", "bedtime_rumpelstiltskin", "bedtime_selfish_giant", "bedtime_snow_queen", "bedtime_three_bears", "bedtime_twelve_dancing_princesses", "blue_castle", "consolation_philosophy", "daddy_long_legs", "david_copperfield", "dorian_gray", "emerson_essays_first", "enchanted_april", "father_brown", "gullivers_travels", "hound_baskervilles", "kidnapped", "les_miserables", "little_lord_fauntleroy", "lorna_doone", "lost_world", "madding_crowd", "middlemarch", "moby_dick", "monte_cristo", "moonstone", "mosses_old_manse", "north_south", "peter_rabbit", "rebecca_sunnybrook", "scarlet_letter", "silas_marner", "tao_te_ching", "the_prophet", "three_musketeers", "walden", "wisdom_of_life"];
assert.deepEqual(Object.keys(versioned).sort(), expectedVersionedIDs);
assert.equal(Object.values(versioned).filter(book => book.freeTier).length, 16);
for (const [id, book] of Object.entries(versioned)) {
  assert.ok(!Object.hasOwn(catalog, id), 'released route must retain priority');
  assert.equal(book.minimumVersion, '1.9.9');
  const {elements} = run('?book=' + encodeURIComponent(id));
  assert.equal(elements['shared-book'].hidden, false);
  assert.equal(elements['shared-book-title'].textContent, book.title);
  assert.equal(elements['shared-book-author'].textContent, 'by ' + book.author);
  assert.equal(elements['shared-book-description'].textContent, book.blurb);
  assert.equal(elements['shared-book-open'].href, 'nightshelf://book/' + id);
  assert.equal(elements['shared-book-edition'].textContent,
    'Requires Nightshelf 1.9.9 or later. ' +
    (book.freeTier ? 'Free on Nightshelf' : 'Included with Nightshelf Pro'));
  assert.match(elements['shared-book-help'].textContent, /update when that version becomes available/);
}

const rejected = ['?book=middlemarch&book=wind_in_willows', '?book=Middlemarch', '?book=middlemarch%2Fevil', '?book=peter_pan', '?book=irish_fairy_tales', '?book=pinocchio', '', '?book=', '?book=missing', '?book=custom_private',
  '?book=__proto__', '?book=constructor', '?book=toString',
  '?book=%3Cscript%3Ealert(1)%3C/script%3E', '?book=javascript%3Aalert(1)',
  '?book=peter_pan&book=wind_in_willows', '?book=Peter_Pan', '?book=peter_pan%2Fevil'];
for (const search of rejected) {
  const { elements, context } = run(search);
  assert.equal(elements['shared-book'].hidden, true, search);
  assert.equal(elements['shared-book-open'].href, '', search);
  assert.equal(context.document.title, 'Nightshelf', search);
}
assert.match(html, /id="shared-book"[^>]*hidden/);
assert.match(html, /https:\/\/apps\.apple\.com\/app\/id6792761643/);
for (const id of Object.keys(run('').elements)) assert.ok(html.includes('id="' + id + '"'), id);
// Shelf counts are the classics; selected tales and Originals carry a kind.
const books = Object.values(catalog).filter(book => !book.kind);
const originals = Object.values(catalog).filter(book => book.kind === 'original');
const selections = Object.values(catalog).filter(book => book.kind === 'selection');
assert.equal(books.length, 93, 'all 93 full-volume routes remain available');
assert.equal(selections.length, 24, 'all twenty-four traditional selection routes remain available');
assert.equal(originals.length, 11, 'all eleven prepared Originals have a shared route');
assert.equal(originals.filter(book => book.freeTier).length, 5, 'five Originals are free');
assert.equal(originals.filter(book => !book.freeTier).length, 6, 'six Originals require Pro');
for (const [id, title, freeTier] of [
  ['original_evening_they_kept', 'The Evening They Kept', true],
  ['original_borrowed_light', 'The Sea of Borrowed Light', false],
  ['original_tide_glass_observatory', 'The Tide-Glass Observatory', true],
  ['original_garden_between_stations', 'The Garden Between Stations', false],
  ['original_space_between_replies', 'The Space Between Replies', true],
]) {
  assert.equal(catalog[id]?.title, title, id + ' must name the intended story');
  assert.equal(catalog[id]?.freeTier, freeTier, id + ' must preserve its intended access');
  assert.equal(catalog[id]?.kind, 'original', id + ' must use the AI-disclosing Original card');
}
assert.equal(Object.keys(catalog).length, 128);
assert.equal(Object.values(catalog).filter(book => book.freeTier).length, 35);
assert.equal(Object.values(catalog).filter(book => !book.freeTier).length, 93);
for (const id of ['canterville_ghost', 'cousin_phillis', 'brick_moon', 'great_stone_sardis']) {
  assert.ok(catalog[id], id + ' must have its new classic route');
  assert.ok(!catalog[id].kind, id + ' must remain a classic book');
}

for (const [id, free] of [
  ['frankenstein', true], ['journey_earth', true], ['tales_shakespeare', true], ['meditations', true],
  ['huckleberry_finn', false], ['prince_pauper', false], ['little_men', false], ['marvelous_land_oz', false],
  ['white_fang', false], ['enchiridion', false], ['apology', false], ['odyssey', false],
]) {
  assert.equal(catalog[id]?.freeTier, free, id + ' access follows the app');
  assert.ok(!catalog[id].kind, id + ' is a full book');
}
for (const [id, free, collection] of [
  ['cinderella', false, 'Tales of Mother Goose'], ['snow_white', true, "Grimm's Fairy Tales"],
  ['sleeping_beauty', true, "Grimm's Fairy Tales"], ['beauty_beast', false, 'The Blue Fairy Book'],
  ['red_riding_hood', true, "Grimm's Fairy Tales"], ['rapunzel', true, "Grimm's Fairy Tales"],
  ['hansel_gretel', true, "Grimm's Fairy Tales"], ['jack_beanstalk', false, 'English Fairy Tales'],
  ['three_pigs', false, 'English Fairy Tales'], ['rip_van_winkle', false, 'The Sketch-Book'],
  ['sleepy_hollow', false, 'The Sketch-Book'], ['tell_tale_heart', false, 'Tales of Mystery & Imagination'],
]) {
  const book = catalog['bedtime_' + id];
  assert.equal(book?.freeTier, free, id + ' inherits source access');
  assert.equal(book.kind, 'selection');
  assert.equal(book.collection, collection);
  assert.ok(book.blurb.includes('complete tale'), id + ' is not called an extra book');
}

const freeCount = books.filter(book => book.freeTier).length;
assert.equal(freeCount, 19);
// The redesign presents capability tiers instead of a decorative spine-count chart.
// Preserve the safety contract: no unqualified catalog totals or free AI-story claim.
const visibleCopy = html.replace(/<script\b[^>]*>[^]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ');
assert.doesNotMatch(visibleCopy, /\b\d+\s+(?:classic\s+)?(?:books|classics|tales|Originals)\b/i,
  'marketing copy must not turn version-dependent routes into a catalog-size promise');
const freePlan = html.match(/<article class="plan">([^]*?)<\/article>/)?.[1];
const proPlan = html.match(/<article class="plan pro">([^]*?)<\/article>/)?.[1];
assert.ok(freePlan && proPlan, 'free and Pro capabilities must remain distinct');
assert.match(freePlan, /free[^]*classic books[^]*selected tales[^]*Originals/i);
assert.match(freePlan, /On-device narration/i);
assert.match(proPlan, /Nightshelf Pro[^]*AI narrators[^]*AI-written bedtime stories/i);
assert.match(html, /which choices are free and which are included with Pro/i);
assert.match(html, /Some features require Nightshelf Pro/i);
assert.match(html, /Availability follows your installed version/i);
assert.match(html, /More options → About this book/);
for (const shot of ['home', 'library', 'reader', 'voices', 'sounds', 'story']) {
  const imagePath = 'shots/20261007/' + shot + '.jpg';
  const imageURL = imagePath + (shot === 'sounds' ? '?v=20261007-soundart62' : '');
  assert.ok(html.includes('src="' + imageURL + '"'), shot + ' must use the current approved capture');
  assert.ok(fs.existsSync(path.join(root, imagePath)), shot + ' capture must exist');
}
for (const name of ['index.html', 'support.html', 'terms.html', 'privacy.html']) {
  const page = fs.readFileSync(path.join(root, name), 'utf8');
  assert.doesNotMatch(page, /\b(?:82(?: complete)? (?:books|classics|works)|eighty-two|eighty(?:-one)?|seventy-seven|(?:thirteen|fifteen)(?: of| free)|fourteen(?: of| free)|sixty-four|sixty-six|sixty-nine)\b/i,
    name + ' must not advertise the retired catalog counts');
  assert.doesNotMatch(page, /(?:93 classic|ninety-three|nineteen of|other seventy-four|complete text|complete selections|About this edition)/i, name + ' must not overstate catalog counts or editions');
  for (const image of page.matchAll(/nightshelf\/og-image\.png\?v=([^"\s]+)/g)) {
    assert.equal(image[1], '20261007-redesign', name + ' must show the current generated OG card');
  }
}
console.log(`PASS: ${books.length} shared books + ${selections.length} tales + ${originals.length} Originals, ${rejected.length} rejected queries, live catalog routes,46 version-qualified cards and version-qualified free/Pro landing copy`);
