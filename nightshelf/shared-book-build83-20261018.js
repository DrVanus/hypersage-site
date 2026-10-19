// Prepared only: additive metadata for the five Sacred readings in 1.9.16 (83).
// Load after shared-book-release-20261018.js and before shared-book.js.
(function () {
  'use strict';
  var additions = {
  "sacred_birth_jesus": {
    "author": "World English Bible",
    "blurb": "Mary and Joseph arrive in Bethlehem, and shepherds hear news of a child’s birth.",
    "coverAsset": "Covers/sacred_birth_jesus",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 83",
    "title": "The Birth of Jesus"
  },
  "sacred_good_samaritan": {
    "author": "World English Bible",
    "blurb": "A traveler offers care to an injured stranger in a parable about being a neighbor.",
    "coverAsset": "Covers/sacred_good_samaritan",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 83",
    "title": "The Good Samaritan"
  },
  "sacred_lost_sheep_coin": {
    "author": "World English Bible",
    "blurb": "Two short parables celebrate finding what was lost: a shepherd’s sheep and a woman’s coin.",
    "coverAsset": "Covers/sacred_lost_sheep_coin",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 83",
    "title": "The Lost Sheep and the Lost Coin"
  },
  "sacred_prodigal_son": {
    "author": "World English Bible",
    "blurb": "A son returns home, a father welcomes him, and an elder brother wrestles with forgiveness.",
    "coverAsset": "Covers/sacred_prodigal_son",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 83",
    "title": "The Prodigal Son"
  },
  "sacred_quiet_psalms": {
    "author": "World English Bible",
    "blurb": "Six psalms of trust, gratitude, and stillness, gathered for quiet listening.",
    "coverAsset": "Covers/sacred_quiet_psalms",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 83",
    "title": "Quiet Psalms"
  }
};
  var base = window.nightshelfSharedBooks || {};
  var versioned = window.nightshelfVersionedSharedBooks || {};
  Object.keys(additions).forEach(function (id) {
    if (Object.prototype.hasOwnProperty.call(base, id) || Object.prototype.hasOwnProperty.call(versioned, id)) {
      throw new Error('Shared catalog changed; review the build 83 additive records.');
    }
  });
  Object.keys(additions).forEach(function (id) { versioned[id] = additions[id]; });
  window.nightshelfVersionedSharedBooks = versioned;
}());
