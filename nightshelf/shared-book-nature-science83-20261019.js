// Prepared only: eight Nature and scientific-romance readings for1.9.16 build83.
// Load after both prepared Sacred overlays and before unchanged shared-book.js.
(function () {
  'use strict';
  var additions = {
  "bedtime_hawthorne_artist_beautiful": {
    "author": "Nathaniel Hawthorne",
    "blurb": "A young watchmaker tries to unite delicate mechanism and living beauty in a creation his neighbors cannot understand. Content: A watchmaker devotes years to creating a mechanical butterfly while others doubt the value of his work. Includes isolation, emotional distress, physical grabbing, alcohol misuse, illness, references to death, and the destruction of his creation. The reflective ending is retained.",
    "coverAsset": "Covers/bedtime_hawthorne_artist_beautiful",
    "freeTier": false,
    "title": "The Artist of the Beautiful",
    "minimumVersion": "1.9.16 build 83"
  },
  "bedtime_hawthorne_birthmark": {
    "author": "Nathaniel Hawthorne",
    "blurb": "A scientist’s attempt to remove a small birthmark turns a marriage into a dangerous experiment in perfection. Content: A scientist’s obsession with removing his wife’s birthmark turns an experiment into a tragedy. Includes coercion, distress about physical appearance, a wish for death, a surgical nightmare, secret dosing, poison, physical grabbing, and death.",
    "coverAsset": "Covers/bedtime_hawthorne_birthmark",
    "freeTier": false,
    "title": "The Birthmark",
    "minimumVersion": "1.9.16 build 83"
  },
  "bedtime_hawthorne_buds_bird_voices": {
    "author": "Nathaniel Hawthorne",
    "blurb": "Late spring at the Old Manse brings thawing riverbanks, budding trees, birdsong, and thoughts about renewal. Content: Aging, death, spiritual reflection, hunting imagery, and historical judgments about beauty and usefulness.",
    "coverAsset": "Covers/bedtime_hawthorne_buds_bird_voices",
    "freeTier": false,
    "title": "Buds and Bird Voices",
    "minimumVersion": "1.9.16 build 83"
  },
  "bedtime_thoreau_brute_neighbors": {
    "author": "Henry David Thoreau",
    "blurb": "A mouse, nesting birds, battling ants, and an elusive loon reveal the lives unfolding around Walden. Content: Fishing and hunting, a detailed violent battle between ants including dismemberment, animal death, and references to war and slavery.",
    "coverAsset": "Covers/bedtime_thoreau_brute_neighbors",
    "freeTier": false,
    "title": "Brute Neighbors",
    "minimumVersion": "1.9.16 build 83"
  },
  "bedtime_thoreau_pond_winter": {
    "author": "Henry David Thoreau",
    "blurb": "Thoreau measures Walden’s depths beneath the ice and watches the winter harvest travel far beyond Concord. Content: Fishing and fish death, a worker falling through ice, historical ethnic stereotypes, and derogatory Indigenous wording.",
    "coverAsset": "Covers/bedtime_thoreau_pond_winter",
    "freeTier": false,
    "title": "The Pond in Winter",
    "minimumVersion": "1.9.16 build 83"
  },
  "bedtime_thoreau_solitude": {
    "author": "Henry David Thoreau",
    "blurb": "Beside Walden Pond, an evening walk and a spell of rain open into reflections on solitude and the companionship of nature. Content: Loneliness and melancholy, spiritual and religious comparisons, and a brief account of a man dying alone in the woods.",
    "coverAsset": "Covers/bedtime_thoreau_solitude",
    "freeTier": false,
    "title": "Solitude",
    "minimumVersion": "1.9.16 build 83"
  },
  "bedtime_thoreau_spring": {
    "author": "Henry David Thoreau",
    "blurb": "Thawing ice, flowing sand, returning birds, and new leaves mark a season of renewal at Walden. Content: Hunting and fishing, a dead horse and carrion, predation and roadkill, mortality, religious reflections, and historical views of nature.",
    "coverAsset": "Covers/bedtime_thoreau_spring",
    "freeTier": false,
    "title": "Spring",
    "minimumVersion": "1.9.16 build 83"
  },
  "bedtime_thoreau_winter_animals": {
    "author": "Henry David Thoreau",
    "blurb": "Squirrels, chickadees, hares, foxes, and hunters cross the woods around Thoreau’s winter cabin. Content: Hunting, a fox being shot and skinned, animal death and snares, and dated Indigenous terminology.",
    "coverAsset": "Covers/bedtime_thoreau_winter_animals",
    "freeTier": false,
    "title": "Winter Animals",
    "minimumVersion": "1.9.16 build 83"
  }
};
  var base = window.nightshelfSharedBooks;
  var versioned = window.nightshelfVersionedSharedBooks;
  if (!base || !versioned) {
    throw new Error('Existing shared catalogs must load before Nature additions.');
  }
  Object.keys(additions).forEach(function (id) {
    if (Object.prototype.hasOwnProperty.call(base, id) || Object.prototype.hasOwnProperty.call(versioned, id)) {
      throw new Error('Shared catalog has changed; review Nature additions.');
    }
  });
  var existing = Object.assign({}, base, versioned);
  if (Object.keys(existing).length !== 488) {
    throw new Error('Expected reviewed488-record predecessor; refresh this prepared packet.');
  }
  Object.keys(additions).forEach(function (id) { versioned[id] = additions[id]; });
}());
