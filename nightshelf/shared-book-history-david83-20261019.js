// PREPARED / UNRELEASED: twelve History and David readings for planned 1.9.16 build 83.
// Load only after the existing 473 catalog and prepared Sacred 5 + Sacred 10 + Nature 8.
(function () {
  'use strict';
  var additions = {
  "history_plutarch_alexander": {
    "author": "Plutarch",
    "blurb": "Plutarch follows the Macedonian king from youth and conquest to his final days and the struggle that follows.",
    "coverAsset": "Covers/history_plutarch_alexander",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 83",
    "title": "Alexander the Great"
  },
  "history_plutarch_caesar": {
    "author": "Plutarch",
    "blurb": "Rome’s republic moves toward civil war as Plutarch traces Caesar’s rise and assassination.",
    "coverAsset": "Covers/history_plutarch_caesar",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 83",
    "title": "Julius Caesar"
  },
  "history_plutarch_cicero": {
    "author": "Plutarch",
    "blurb": "An advocate and statesman navigates the rivalries and violence of the late Roman republic.",
    "coverAsset": "Covers/history_plutarch_cicero",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 83",
    "title": "Cicero"
  },
  "history_plutarch_demosthenes": {
    "author": "Plutarch",
    "blurb": "An Athenian orator finds his voice and confronts Macedonian power.",
    "coverAsset": "Covers/history_plutarch_demosthenes",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 83",
    "title": "Demosthenes"
  },
  "history_plutarch_pericles": {
    "author": "Plutarch",
    "blurb": "A portrait of Athenian public life, building projects, political rivalry, war, and plague.",
    "coverAsset": "Covers/history_plutarch_pericles",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 83",
    "title": "Pericles"
  },
  "history_plutarch_solon": {
    "author": "Plutarch",
    "blurb": "The Athenian lawgiver confronts debt, power, and the limits of reform.",
    "coverAsset": "Covers/history_plutarch_solon",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 83",
    "title": "Solon"
  },
  "sacred_david_abigail": {
    "author": "World English Bible",
    "blurb": "Abigail brings provisions into the hills and speaks to David before anger becomes bloodshed.",
    "coverAsset": "Covers/sacred_david_abigail",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 83",
    "title": "David and Abigail"
  },
  "sacred_david_anointed": {
    "author": "World English Bible",
    "blurb": "Samuel visits Jesse’s family in Bethlehem and calls for the youngest son, a shepherd.",
    "coverAsset": "Covers/sacred_david_anointed",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 83",
    "title": "David Is Anointed"
  },
  "sacred_david_jonathan": {
    "author": "World English Bible",
    "blurb": "Jonathan tests his father’s intentions and signals to David with arrows before a difficult farewell.",
    "coverAsset": "Covers/sacred_david_jonathan",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 83",
    "title": "David and Jonathan"
  },
  "sacred_david_king": {
    "author": "World English Bible",
    "blurb": "The elders come to Hebron, and the account follows David’s kingship over Israel and his settlement in Jerusalem.",
    "coverAsset": "Covers/sacred_david_king",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 83",
    "title": "David Becomes King"
  },
  "sacred_david_mephibosheth": {
    "author": "World English Bible",
    "blurb": "Remembering Jonathan, David welcomes his son Mephibosheth and offers him a lasting place at his table.",
    "coverAsset": "Covers/sacred_david_mephibosheth",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 83",
    "title": "David and Mephibosheth"
  },
  "sacred_david_spares_saul": {
    "author": "World English Bible",
    "blurb": "In the caves near En Gedi, David chooses restraint and calls to Saul with a piece of the king’s robe.",
    "coverAsset": "Covers/sacred_david_spares_saul",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 83",
    "title": "David Spares Saul"
  }
};
  var base = window.nightshelfSharedBooks;
  var versioned = window.nightshelfVersionedSharedBooks;
  if (!base || !versioned) throw new Error('Existing shared catalogs must load before the History/David successor.');
  var merged = Object.assign({}, base, versioned);
  if (Object.keys(merged).length !== 496) throw new Error('Expected reviewed 496 predecessor records; regenerate this prepared successor.');
  Object.keys(additions).forEach(function (id) {
    if (Object.prototype.hasOwnProperty.call(base, id) || Object.prototype.hasOwnProperty.call(versioned, id)) {
      throw new Error('Shared catalog has changed; regenerate the History/David successor.');
    }
  });
  Object.keys(additions).forEach(function (id) { versioned[id] = additions[id]; });
}());
