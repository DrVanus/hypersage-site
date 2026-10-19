// Prepared only: ten additional Sacred readings for 1.9.16 (83).
// Load after shared-book-build83-20261018.js, before the unchanged shared-book.js.
(function () {
  'use strict';
  var additions = {
  "sacred_elijah_quiet_voice": {
    "author": "World English Bible",
    "blurb": "Elijah journeys from the wilderness to a mountain cave, where he hears a quiet voice after wind, earthquake, and fire.",
    "coverAsset": "Covers/sacred_elijah_quiet_voice",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 83",
    "title": "Elijah and the Quiet Voice"
  },
  "sacred_emmaus": {
    "author": "World English Bible",
    "blurb": "Two travelers meet a stranger on the road and recognize him when bread is broken.",
    "coverAsset": "Covers/sacred_emmaus",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 83",
    "title": "The Road to Emmaus"
  },
  "sacred_feeding_five_thousand": {
    "author": "World English Bible",
    "blurb": "A crowd gathers in a quiet place, where five loaves and two fish become a shared meal.",
    "coverAsset": "Covers/sacred_feeding_five_thousand",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 83",
    "title": "Feeding the Five Thousand"
  },
  "sacred_fiery_furnace": {
    "author": "World English Bible",
    "blurb": "Shadrach, Meshach, and Abednego refuse a king’s command and are cast into a blazing furnace.",
    "coverAsset": "Covers/sacred_fiery_furnace",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 83",
    "title": "The Fiery Furnace"
  },
  "sacred_jacob_dream": {
    "author": "World English Bible",
    "blurb": "Jacob sleeps with a stone for a pillow and dreams of a stairway joining earth and heaven.",
    "coverAsset": "Covers/sacred_jacob_dream",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 83",
    "title": "Jacob’s Dream"
  },
  "sacred_jesus_calms_storm": {
    "author": "World English Bible",
    "blurb": "On an evening crossing, Jesus and his disciples face a sudden storm on the lake.",
    "coverAsset": "Covers/sacred_jesus_calms_storm",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 83",
    "title": "Jesus Calms the Storm"
  },
  "sacred_samuel_call": {
    "author": "World English Bible",
    "blurb": "A young Samuel hears a voice in the night, while Eli helps him understand how to answer.",
    "coverAsset": "Covers/sacred_samuel_call",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 83",
    "title": "Samuel Hears a Call"
  },
  "sacred_sower": {
    "author": "World English Bible",
    "blurb": "A farmer scatters seed across different ground in a parable Jesus later explains to his disciples.",
    "coverAsset": "Covers/sacred_sower",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 83",
    "title": "The Parable of the Sower"
  },
  "sacred_wedding_cana": {
    "author": "World English Bible",
    "blurb": "At a wedding in Cana, servants fill six stone jars and find the celebration unexpectedly renewed.",
    "coverAsset": "Covers/sacred_wedding_cana",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 83",
    "title": "The Wedding at Cana"
  },
  "sacred_zacchaeus": {
    "author": "World English Bible",
    "blurb": "A tax collector climbs a sycamore tree and receives an unexpected invitation to change his life.",
    "coverAsset": "Covers/sacred_zacchaeus",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 83",
    "title": "Jesus and Zacchaeus"
  }
};
  var base = window.nightshelfSharedBooks || {};
  var versioned = window.nightshelfVersionedSharedBooks || {};
  Object.keys(additions).forEach(function (id) {
    if (Object.prototype.hasOwnProperty.call(base, id) || Object.prototype.hasOwnProperty.call(versioned, id)) {
      throw new Error('Shared catalog changed; review the Sacred build 83 additive records.');
    }
  });
  Object.keys(additions).forEach(function (id) { versioned[id] = additions[id]; });
  window.nightshelfVersionedSharedBooks = versioned;
}());
