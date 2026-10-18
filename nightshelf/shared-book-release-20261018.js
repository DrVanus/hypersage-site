// Prepared from the integrated Nightshelf catalog. Requires the completed 1.9.16 update.
// Add this AFTER shared-book-versioned.js and BEFORE shared-book.js. Existing records are retained; one reviewed source-credit field is corrected.
(function () {
  'use strict';
  var additions = {
  "aesops_fables_jacobs": {
    "author": "Aesop",
    "blurb": "Eighty-two fables retold by Joseph Jacobs: foxes, lions, tiny kindnesses and hard-earned lessons. Includes Jacobs’s preface and history of the fable.",
    "coverAsset": "Covers/aesops_fables_jacobs",
    "freeTier": true,
    "minimumVersion": "1.9.15 build 81",
    "title": "Aesop’s Fables"
  },
  "agnes_grey": {
    "author": "Anne Brontë",
    "blurb": "A young governess finds her own voice and a quiet love while working in difficult households. A hopeful courtship story with class prejudice, bereavement, and scenes of animal cruelty.",
    "coverAsset": "Covers/agnes_grey",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "Agnes Grey"
  },
  "analects": {
    "author": "Confucius",
    "blurb": "Brief conversations and observations on learning, friendship, responsibility, and good government. Twenty books of teachings attributed to Confucius and his followers.",
    "coverAsset": "Covers/analects",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Analects"
  },
  "anna_karenina": {
    "author": "Leo Tolstoy",
    "blurb": "Anna's love affair and Levin's search for a meaningful life unfold among Russian families, estates, and drawing rooms. Tolstoy explores marriage, desire, work, faith, and loss in a novel with a tragic central story.",
    "coverAsset": "Covers/anna_karenina",
    "freeTier": false,
    "minimumVersion": "1.9.15 build 81",
    "title": "Anna Karenina"
  },
  "bacon_essays": {
    "author": "Francis Bacon",
    "blurb": "Compact reflections on truth, friendship, travel, gardens, study, ambition, and public life. Bacon’s practical observations retain the language and social prejudices of their period.",
    "coverAsset": "Covers/bacon_essays",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "Essays"
  },
  "bedtime_ali_baba": {
    "author": "Andrew Lang",
    "blurb": "A hidden treasure and Morgiana’s quick thinking outwit a band of robbers. This older retelling includes slavery, dismemberment, execution, and deaths by boiling oil and stabbing.",
    "coverAsset": "Covers/bedtime_ali_baba",
    "freeTier": false,
    "minimumVersion": "1.9.15 build 81",
    "title": "Ali Baba and the Forty Thieves"
  },
  "bedtime_anansi_wisdom": {
    "author": "W. H. Barker & Cecilia Sinclair",
    "blurb": "Father Anansi tries to hide all wisdom in a pot, until his son notices a simpler way to carry it. A complete tale from Barker and Sinclair’s 1917 collection.",
    "coverAsset": "Covers/bedtime_anansi_wisdom",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "How Wisdom Became the Property of the Human Race"
  },
  "bedtime_andersen_the_bell": {
    "author": "Hans Christian Andersen",
    "blurb": "Two young seekers follow a mysterious bell into the forest and find wonder in the natural world.",
    "coverAsset": "Covers/andersen_fairy_tales",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Bell"
  },
  "bedtime_andersen_the_elderbush": {
    "author": "Hans Christian Andersen",
    "blurb": "An old storyteller turns a cup of elderflower tea into a journey through memory and married life.",
    "coverAsset": "Covers/andersen_fairy_tales",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Elderbush"
  },
  "bedtime_andersen_the_fir_tree": {
    "author": "Hans Christian Andersen",
    "blurb": "A fir tree longs to grow up and discovers too late what it has lost. Ends with the tree being burned.",
    "coverAsset": "Covers/andersen_fairy_tales",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Fir Tree"
  },
  "bedtime_andersen_the_happy_family": {
    "author": "Hans Christian Andersen",
    "blurb": "Two elderly snails search for a suitable match for their adopted son among the burdock leaves.",
    "coverAsset": "Covers/andersen_fairy_tales",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Happy Family"
  },
  "bedtime_andersen_the_leap_frog": {
    "author": "Hans Christian Andersen",
    "blurb": "A flea, a grasshopper and a leap-frog compete to win a princess in a small satire about appearances.",
    "coverAsset": "Covers/andersen_fairy_tales",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Leap-Frog"
  },
  "bedtime_andersen_the_old_house": {
    "author": "Hans Christian Andersen",
    "blurb": "A boy befriends the lonely owner of an ancient house. Includes loneliness, death and the passing of a beloved home.",
    "coverAsset": "Covers/andersen_fairy_tales",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Old House"
  },
  "bedtime_andersen_the_swineherd": {
    "author": "Hans Christian Andersen",
    "blurb": "A disguised prince tests a princess’s taste with a singing pot and a musical rattle. A satirical tale of pride and rejection.",
    "coverAsset": "Covers/andersen_fairy_tales",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Swineherd"
  },
  "bedtime_arthur_sword": {
    "author": "Howard Pyle",
    "blurb": "A young squire draws a wondrous sword from an anvil and discovers his birthright. Howard Pyle’s complete adventure of Arthur’s rise to kinghood, with its prologue and all three chapters. Includes tournament combat, injuries, civil war, hostages and the death of Uther-Pendragon.",
    "coverAsset": "Covers/bedtime_arthur_sword",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "Arthur and the Sword in the Stone"
  },
  "bedtime_baba_yaga": {
    "author": "W. R. S. Ralston",
    "blurb": "A Russian folktale in W. R. S. Ralston’s translation. A young girl escapes Baba Yaga with help from those she treats kindly. Includes threats to eat a child and the violent death of her stepmother.",
    "coverAsset": "Covers/bedtime_baba_yaga",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Baba Yaga"
  },
  "bedtime_bacon_adversity": {
    "author": "Francis Bacon",
    "blurb": "A brief complete essay on fortitude, adversity, and the character revealed by difficulty.",
    "coverAsset": "Covers/bacon_essays",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "Of Adversity"
  },
  "bedtime_bacon_friendship": {
    "author": "Francis Bacon",
    "blurb": "Bacon reflects on companionship, confidence, and counsel in this complete essay on friendship.",
    "coverAsset": "Covers/bacon_essays",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "Of Friendship"
  },
  "bedtime_bacon_gardens": {
    "author": "Francis Bacon",
    "blurb": "A complete essay imagining the pleasures, seasons, and design of a garden, from flowers and fruit to shade and open air.",
    "coverAsset": "Covers/bacon_essays",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "Of Gardens"
  },
  "bedtime_bacon_studies": {
    "author": "Francis Bacon",
    "blurb": "A brief complete essay on reading, discussion, writing, and the practical uses of learning.",
    "coverAsset": "Covers/bacon_essays",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "Of Studies"
  },
  "bedtime_bacon_travel": {
    "author": "Francis Bacon",
    "blurb": "Bacon considers how travel can become an education in places, people, and unfamiliar ways of living. The complete essay reflects the assumptions of its period.",
    "coverAsset": "Covers/bacon_essays",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "Of Travel"
  },
  "bedtime_bacon_truth": {
    "author": "Francis Bacon",
    "blurb": "A complete essay on truth, falsehood, and the appeal of comforting illusions.",
    "coverAsset": "Covers/bacon_essays",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "Of Truth"
  },
  "bedtime_bamboo_cutter": {
    "author": "Yei Theodora Ozaki",
    "blurb": "A bamboo-cutter discovers a tiny child who grows into a mysterious princess. Ozaki’s complete Japanese legend includes impossible quests, loss, and a farewell to Earth.",
    "coverAsset": "Covers/bedtime_bamboo_cutter",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Bamboo-cutter and the Moon-child"
  },
  "bedtime_battle_owls": {
    "author": "Jos. M. Poepoe",
    "blurb": "A man returns an owl’s eggs, and the owls later rescue him from a king’s sentence. A Hawaiian legend contributed by Jos. M. Poepoe; includes threatened execution and a battle.",
    "coverAsset": "Covers/bedtime_battle_owls",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "Battle of the Owls"
  },
  "bedtime_binding_fenrir": {
    "author": "Annie & Eliza Keary",
    "blurb": "The gods seek a chain that can hold the mighty wolf Fenrir. This complete Norse tale includes deception, restraint, and Tyr’s sacrifice of his hand.",
    "coverAsset": "Covers/bedtime_binding_fenrir",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Binding of Fenrir"
  },
  "bedtime_black_cat": {
    "author": "Edgar Allan Poe",
    "blurb": "A condemned man recounts his cruelty and a terrible crime. Poe’s Gothic tale includes animal abuse, domestic violence, and murder.",
    "coverAsset": "Covers/poe_tales",
    "freeTier": false,
    "minimumVersion": "1.9.15 build 81",
    "title": "The Black Cat"
  },
  "bedtime_boy_cried_wolf_jacobs": {
    "author": "Aesop",
    "blurb": "Joseph Jacobs’s complete fable about trust and false alarms, published as The Shepherd’s Boy. The wolf kills the sheep when help no longer comes.",
    "coverAsset": "Covers/bedtime_boy_cried_wolf_jacobs",
    "freeTier": true,
    "minimumVersion": "1.9.15 build 81",
    "title": "The Boy Who Cried Wolf"
  },
  "bedtime_cask_amontillado": {
    "author": "Edgar Allan Poe",
    "blurb": "An invitation to taste a rare wine leads deep into the catacombs. Poe’s revenge story includes deception and murder.",
    "coverAsset": "Covers/poe_tales",
    "freeTier": false,
    "minimumVersion": "1.9.15 build 81",
    "title": "The Cask of Amontillado"
  },
  "bedtime_celtic_brewery_of_eggshells": {
    "author": "Joseph Jacobs",
    "blurb": "A mother follows strange advice to recover her children from fairy changelings. Includes children being thrown into water.",
    "coverAsset": "Covers/celtic_fairy_tales",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "Brewery Of Eggshells"
  },
  "bedtime_celtic_connla_and_the_fairy_maiden": {
    "author": "Joseph Jacobs",
    "blurb": "A fairy maiden invites a king’s son to leave the mortal world in a crystal boat.",
    "coverAsset": "Covers/bedtime_connla",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "Connla And The Fairy Maiden"
  },
  "bedtime_celtic_the_field_of_boliauns": {
    "author": "Joseph Jacobs",
    "blurb": "A man catches a leprechaun and tries to mark the hiding place of his gold.",
    "coverAsset": "Covers/celtic_fairy_tales",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Field Of Boliauns"
  },
  "bedtime_celtic_the_horned_women": {
    "author": "Joseph Jacobs",
    "blurb": "A woman must outwit a company of horned witches who invade her home.",
    "coverAsset": "Covers/celtic_fairy_tales",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Horned Women"
  },
  "bedtime_celtic_the_shepherd_of_myddvai": {
    "author": "Joseph Jacobs",
    "blurb": "A shepherd marries a woman from a mountain lake under a fragile condition. Includes domestic blows and separation.",
    "coverAsset": "Covers/celtic_fairy_tales",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Shepherd Of Myddvai"
  },
  "bedtime_celtic_the_sprightly_tailor": {
    "author": "Joseph Jacobs",
    "blurb": "A tailor accepts the challenge of sewing in a haunted church while a terrifying figure rises beside him.",
    "coverAsset": "Covers/celtic_fairy_tales",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Sprightly Tailor"
  },
  "bedtime_chimaera": {
    "author": "Nathaniel Hawthorne",
    "blurb": "Bellerophon befriends the winged horse Pegasus and confronts the Chimæra. Hawthorne’s complete Greek myth includes a dangerous quest and a battle with a monster.",
    "coverAsset": "Covers/bedtime_chimaera",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Chimæra"
  },
  "bedtime_chinese_bamboo_and_the_turtle": {
    "author": "Norman Hinsdale Pitman",
    "blurb": "A boy in a temple encounters an ancient stone turtle and discovers a story beneath its solemn exterior.",
    "coverAsset": "Covers/chinese_wonder_book",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "Bamboo And The Turtle"
  },
  "bedtime_chinese_lu_san_daughter_of_heaven": {
    "author": "Norman Hinsdale Pitman",
    "blurb": "A mistreated child finds compassion and an extraordinary destiny with the Goddess of Mercy. Includes family abuse and separation.",
    "coverAsset": "Covers/chinese_wonder_book",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "Lu-San, Daughter Of Heaven"
  },
  "bedtime_chinese_the_golden_beetle_or_why_the_dog_hates_the_cat": {
    "author": "Norman Hinsdale Pitman",
    "blurb": "A widow’s enchanted treasure brings prosperity, but a dog and cat’s quarrel threatens it.",
    "coverAsset": "Covers/chinese_wonder_book",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Golden Beetle Or Why The Dog Hates The Cat"
  },
  "bedtime_chinese_the_golden_nugget": {
    "author": "Norman Hinsdale Pitman",
    "blurb": "Two friends refuse to let a lucky find come between them. Includes danger from robbers.",
    "coverAsset": "Covers/chinese_wonder_book",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Golden Nugget"
  },
  "bedtime_connla": {
    "author": "Joseph Jacobs",
    "blurb": "An Irish Otherworld tale retold by Joseph Jacobs. A fairy maiden draws Connla away from his family to a land beyond the sea.",
    "coverAsset": "Covers/bedtime_connla",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "Connla and the Fairy Maiden"
  },
  "bedtime_crystal_egg": {
    "author": "H. G. Wells",
    "blurb": "An antique dealer sees an unfamiliar world inside a crystal. A complete science-fiction mystery, with obsession and death.",
    "coverAsset": "Covers/tales_space_time",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Crystal Egg"
  },
  "bedtime_dunsany_a_narrow_escape": {
    "author": "Lord Dunsany",
    "blurb": "A magician’s underground ritual depends on a dangerously incomplete collection of ingredients. From Tales of Wonder.",
    "coverAsset": "Covers/tales_wonder",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "A Narrow Escape"
  },
  "bedtime_dunsany_a_story_of_land_and_sea": {
    "author": "Lord Dunsany",
    "blurb": "Captain Shard takes his pirate ship on an impossible voyage across land. Includes the complete fictional Guarantee to the Reader, violence and period stereotypes. From Tales of Wonder.",
    "coverAsset": "Covers/tales_wonder",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "A Story Of Land And Sea"
  },
  "bedtime_dunsany_a_tale_of_london": {
    "author": "Lord Dunsany",
    "blurb": "A dreamer describes an impossibly splendid London to a sultan. Includes drug use and period stereotypes. From Tales of Wonder.",
    "coverAsset": "Covers/tales_wonder",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "A Tale Of London"
  },
  "bedtime_dunsany_a_tale_of_the_equator": {
    "author": "Lord Dunsany",
    "blurb": "A poet describes a dreamed kingdom to an eastern ruler, with unexpected consequences. From Tales of Wonder.",
    "coverAsset": "Covers/tales_wonder",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "A Tale Of The Equator"
  },
  "bedtime_dunsany_chu_bu_and_sheemish": {
    "author": "Lord Dunsany",
    "blurb": "Two jealous idols compete for worship in a temple, with absurd and destructive consequences. From The Book of Wonder.",
    "coverAsset": "Covers/book_wonder",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "Chu-Bu And Sheemish"
  },
  "bedtime_dunsany_distressing_tale_of_thangobrind_the_jeweller": {
    "author": "Lord Dunsany",
    "blurb": "A celebrated jewel thief steals from a god and discovers the cost of his prize. From The Book of Wonder.",
    "coverAsset": "Covers/book_wonder",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "Distressing Tale Of Thangobrind The Jeweller"
  },
  "bedtime_dunsany_how_ali_came_to_the_black_country": {
    "author": "Lord Dunsany",
    "blurb": "A visitor’s journey to industrial England becomes a satire about beauty and modern life. Contains period stereotypes. From Tales of Wonder.",
    "coverAsset": "Covers/tales_wonder",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "How Ali Came To The Black Country"
  },
  "bedtime_dunsany_how_nuth_would_have_practised_his_art_upon_the_gnoles": {
    "author": "Lord Dunsany",
    "blurb": "A master thief takes an apprentice into the country of the Gnoles, with grim results. From The Book of Wonder.",
    "coverAsset": "Covers/book_wonder",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "How Nuth Would Have Practised His Art Upon The Gnoles"
  },
  "bedtime_dunsany_how_one_came_as_was_foretold_to_the_city_of_never": {
    "author": "Lord Dunsany",
    "blurb": "An ordinary life is drawn toward a mysterious city at the edge of possibility. From The Book of Wonder.",
    "coverAsset": "Covers/book_wonder",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "How One Came, As Was Foretold, To The City Of Never"
  },
  "bedtime_dunsany_how_plash_goo_came_to_the_land_of_none_s_desire": {
    "author": "Lord Dunsany",
    "blurb": "The mighty Plash-Goo challenges a seemingly lesser opponent and meets a grim fate. From Tales of Wonder.",
    "coverAsset": "Covers/tales_wonder",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "How Plash-Goo Came To The Land Of None's Desire"
  },
  "bedtime_dunsany_miss_cubbidge_and_the_dragon_of_romance": {
    "author": "Lord Dunsany",
    "blurb": "A dragon carries a young woman out of London and into a life that respectable acquaintances cannot approve. From The Book of Wonder.",
    "coverAsset": "Covers/book_wonder",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "Miss Cubbidge And The Dragon Of Romance"
  },
  "bedtime_dunsany_probable_adventure_of_the_three_literary_men": {
    "author": "Lord Dunsany",
    "blurb": "Three literary adventurers attempt to steal a golden box from the edge of the world. From The Book of Wonder.",
    "coverAsset": "Covers/book_wonder",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "Probable Adventure Of The Three Literary Men"
  },
  "bedtime_dunsany_the_bad_old_woman_in_black": {
    "author": "Lord Dunsany",
    "blurb": "An ominous woman runs through an ancient city, leaving its rulers to interpret the warning. From Tales of Wonder.",
    "coverAsset": "Covers/tales_wonder",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Bad Old Woman In Black"
  },
  "bedtime_dunsany_the_bird_of_the_difficult_eye": {
    "author": "Lord Dunsany",
    "blurb": "A fantastic bird disrupts the ordinary business of a London jeweller. From Tales of Wonder.",
    "coverAsset": "Covers/tales_wonder",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Bird Of The Difficult Eye"
  },
  "bedtime_dunsany_the_bride_of_the_man_horse": {
    "author": "Lord Dunsany",
    "blurb": "A centaur leaves home with an ancient horn and follows his destiny toward a strange city. From The Book of Wonder.",
    "coverAsset": "Covers/book_wonder",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Bride Of The Man-Horse"
  },
  "bedtime_dunsany_the_bureau_d_echange_de_maux": {
    "author": "Lord Dunsany",
    "blurb": "A Parisian bureau offers an uncanny exchange of misfortunes. From Tales of Wonder.",
    "coverAsset": "Covers/tales_wonder",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Bureau D'Echange De Maux"
  },
  "bedtime_dunsany_the_city_on_mallington_moor": {
    "author": "Lord Dunsany",
    "blurb": "A traveller follows a rumour of a magnificent city hidden on an empty moor. From Tales of Wonder.",
    "coverAsset": "Covers/tales_wonder",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "The City On Mallington Moor"
  },
  "bedtime_dunsany_the_coronation_of_mr_thomas_shap": {
    "author": "Lord Dunsany",
    "blurb": "A businessman constructs an imaginary kingdom that gradually consumes his daily life. Includes mental distress. From The Book of Wonder.",
    "coverAsset": "Covers/book_wonder",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Coronation Of Mr. Thomas Shap"
  },
  "bedtime_dunsany_the_exiles_club": {
    "author": "Lord Dunsany",
    "blurb": "An invitation leads a visitor into a club whose members belong to forgotten religions. From Tales of Wonder.",
    "coverAsset": "Covers/tales_wonder",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Exiles Club"
  },
  "bedtime_dunsany_the_hoard_of_the_gibbelins": {
    "author": "Lord Dunsany",
    "blurb": "A man sets out to steal the treasure of the man-eating Gibbelins. Ends with his execution. From The Book of Wonder.",
    "coverAsset": "Covers/book_wonder",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Hoard Of The Gibbelins"
  },
  "bedtime_dunsany_the_house_of_the_sphinx": {
    "author": "Lord Dunsany",
    "blurb": "A traveller seeks shelter in the house of the Sphinx, where sorrow and madness take unsettling forms. From The Book of Wonder.",
    "coverAsset": "Covers/book_wonder",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "The House Of The Sphinx"
  },
  "bedtime_dunsany_the_injudicious_prayers_of_pombo_the_idolater": {
    "author": "Lord Dunsany",
    "blurb": "An impatient worshipper discovers that insulting an idol can have unexpected consequences. From The Book of Wonder.",
    "coverAsset": "Covers/book_wonder",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Injudicious Prayers Of Pombo The Idolater"
  },
  "bedtime_dunsany_the_long_porter_s_tale": {
    "author": "Lord Dunsany",
    "blurb": "A porter’s extraordinary recollections leave a listener uncertain what to believe. From Tales of Wonder.",
    "coverAsset": "Covers/tales_wonder",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Long Porter's Tale"
  },
  "bedtime_dunsany_the_loot_of_bombasharna": {
    "author": "Lord Dunsany",
    "blurb": "Captain Shard’s pirates sack a city and carry away a queen with plans of her own. From The Book of Wonder.",
    "coverAsset": "Covers/book_wonder",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Loot Of Bombasharna"
  },
  "bedtime_dunsany_the_loot_of_loma": {
    "author": "Lord Dunsany",
    "blurb": "Four men carry plunder from a ruined city, unaware of the curse among their possessions. From Tales of Wonder.",
    "coverAsset": "Covers/tales_wonder",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Loot Of Loma"
  },
  "bedtime_dunsany_the_quest_of_the_queen_s_tears": {
    "author": "Lord Dunsany",
    "blurb": "The suitors of a woodland queen attempt to make her weep, and awaken a terrible sorrow. From The Book of Wonder.",
    "coverAsset": "Covers/book_wonder",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Quest Of The Queen's Tears"
  },
  "bedtime_dunsany_the_secret_of_the_sea": {
    "author": "Lord Dunsany",
    "blurb": "A sailor’s account hints at a terrible secret beneath the sea. Includes death. From Tales of Wonder.",
    "coverAsset": "Covers/tales_wonder",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Secret Of The Sea"
  },
  "bedtime_dunsany_the_three_infernal_jokes": {
    "author": "Lord Dunsany",
    "blurb": "A desolate traveller recounts a bargain involving three jokes with deadly consequences. From Tales of Wonder.",
    "coverAsset": "Covers/tales_wonder",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Three Infernal Jokes"
  },
  "bedtime_dunsany_the_three_sailors_gambit": {
    "author": "Lord Dunsany",
    "blurb": "Three sailors confound the world of chess with an extraordinary source of advice. From Tales of Wonder.",
    "coverAsset": "Covers/tales_wonder",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Three Sailors' Gambit"
  },
  "bedtime_dunsany_the_watch_tower": {
    "author": "Lord Dunsany",
    "blurb": "A traveller meets an ancient watchman still keeping vigil above a town in Provence. From Tales of Wonder.",
    "coverAsset": "Covers/tales_wonder",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Watch-Tower"
  },
  "bedtime_dunsany_the_wonderful_window": {
    "author": "Lord Dunsany",
    "blurb": "A shop assistant buys a window looking into an extraordinary city and watches its fate unfold. From The Book of Wonder.",
    "coverAsset": "Covers/book_wonder",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Wonderful Window"
  },
  "bedtime_dunsany_thirteen_at_table": {
    "author": "Lord Dunsany",
    "blurb": "An uninvited guest discovers why a lonely host has spent years dining with thirteen at table. From Tales of Wonder.",
    "coverAsset": "Covers/tales_wonder",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "Thirteen At Table"
  },
  "bedtime_dunsany_why_the_milkman_shudders_when_he_perceives_the_dawn": {
    "author": "Lord Dunsany",
    "blurb": "Milkmen tell a strange winter tale that explains their dread of the dawn. From Tales of Wonder.",
    "coverAsset": "Covers/tales_wonder",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "Why The Milkman Shudders When He Perceives The Dawn"
  },
  "bedtime_emerson_art": {
    "author": "Ralph Waldo Emerson",
    "blurb": "Emerson considers creativity, perception, beauty, and the relationship between art and everyday life. Includes the complete essay and its opening verse.",
    "coverAsset": "Covers/emerson_essays_first",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "Art"
  },
  "bedtime_emerson_circles": {
    "author": "Ralph Waldo Emerson",
    "blurb": "A circle becomes Emerson’s image for growth, discovery, and the limits of every settled idea. Includes the complete essay and its prefatory verse.",
    "coverAsset": "Covers/emerson_essays_first",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "Circles"
  },
  "bedtime_emerson_compensation": {
    "author": "Ralph Waldo Emerson",
    "blurb": "A searching essay on consequence, balance, and moral life. Emerson’s argument includes historical religious beliefs and claims about suffering.",
    "coverAsset": "Covers/emerson_essays_first",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "Compensation"
  },
  "bedtime_emerson_friendship": {
    "author": "Ralph Waldo Emerson",
    "blurb": "Emerson considers sincerity, affection, solitude, and the demanding ideal of friendship. The complete essay includes its prefatory verse.",
    "coverAsset": "Covers/emerson_essays_first",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "Friendship"
  },
  "bedtime_emerson_heroism": {
    "author": "Ralph Waldo Emerson",
    "blurb": "Emerson explores courage, independence, and moral conviction through historical examples. Includes the complete essay and its opening verse.",
    "coverAsset": "Covers/emerson_essays_first",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "Heroism"
  },
  "bedtime_emerson_history": {
    "author": "Ralph Waldo Emerson",
    "blurb": "Emerson reads history through personal experience, imagination, and the shared possibilities of human life. The complete essay includes its opening verse.",
    "coverAsset": "Covers/emerson_essays_first",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "History"
  },
  "bedtime_emerson_intellect": {
    "author": "Ralph Waldo Emerson",
    "blurb": "Emerson explores perception, inspiration, and how thoughts take shape. Includes the complete essay and its prefatory verse.",
    "coverAsset": "Covers/emerson_essays_first",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "Intellect"
  },
  "bedtime_emerson_love": {
    "author": "Ralph Waldo Emerson",
    "blurb": "Emerson considers how affection changes perception and grows into broader sympathy. Includes the complete essay and its prefatory verse.",
    "coverAsset": "Covers/emerson_essays_first",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "Love"
  },
  "bedtime_emerson_over_soul": {
    "author": "Ralph Waldo Emerson",
    "blurb": "Emerson’s complete spiritual essay considers intuition, the soul, and a shared unity beneath individual lives. Includes its opening verses.",
    "coverAsset": "Covers/emerson_essays_first",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Over-Soul"
  },
  "bedtime_emerson_prudence": {
    "author": "Ralph Waldo Emerson",
    "blurb": "A complete essay on practical judgment, everyday responsibilities, and the connection between ideals and conduct. Includes its prefatory verse.",
    "coverAsset": "Covers/emerson_essays_first",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "Prudence"
  },
  "bedtime_emerson_self_reliance": {
    "author": "Ralph Waldo Emerson",
    "blurb": "Emerson’s complete essay on trusting one’s judgment, resisting conformity, and finding an independent voice. Includes its opening epigraphs and verse.",
    "coverAsset": "Covers/emerson_essays_first",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "Self-Reliance"
  },
  "bedtime_emerson_spiritual_laws": {
    "author": "Ralph Waldo Emerson",
    "blurb": "Emerson reflects on vocation, character, and the relationship between inner life and outward action. Includes the complete essay and its prefatory verse.",
    "coverAsset": "Covers/emerson_essays_first",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "Spiritual Laws"
  },
  "bedtime_english_fairy_ointment": {
    "author": "Joseph Jacobs",
    "blurb": "A nurse discovers the hidden fairy world with an enchanted ointment. Ends with an injury that leaves her blind in one eye.",
    "coverAsset": "Covers/english_fairy_tales",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "Fairy Ointment"
  },
  "bedtime_english_henny_penny": {
    "author": "Joseph Jacobs",
    "blurb": "Henny-penny mistakes a falling acorn for the sky and gathers companions on the way to warn the king. Includes a fox killing the birds.",
    "coverAsset": "Covers/english_fairy_tales",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "Henny-Penny"
  },
  "bedtime_english_johnny_cake": {
    "author": "Joseph Jacobs",
    "blurb": "A runaway cake boasts that no one can catch him—until he meets a fox.",
    "coverAsset": "Covers/english_fairy_tales",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "Johnny-Cake"
  },
  "bedtime_english_kate_crackernuts": {
    "author": "Joseph Jacobs",
    "blurb": "Two stepsisters confront enchantment and a mysterious nightly fairy dance. Includes illness and frightening transformations.",
    "coverAsset": "Covers/english_fairy_tales",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "Kate Crackernuts"
  },
  "bedtime_english_lazy_jack": {
    "author": "Joseph Jacobs",
    "blurb": "A boy follows yesterday’s instructions for today’s wages, with increasingly absurd results.",
    "coverAsset": "Covers/english_fairy_tales",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "Lazy Jack"
  },
  "bedtime_english_molly_whuppie": {
    "author": "Joseph Jacobs",
    "blurb": "A resourceful girl outwits a giant to protect herself and her sisters. Includes child abandonment and violent deaths.",
    "coverAsset": "Covers/english_fairy_tales",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "Molly Whuppie"
  },
  "bedtime_english_the_magpie_s_nest": {
    "author": "Joseph Jacobs",
    "blurb": "The magpie teaches the birds how to build nests, but each pupil leaves before the lesson is finished.",
    "coverAsset": "Covers/english_fairy_tales",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Magpie's Nest"
  },
  "bedtime_fall_usher": {
    "author": "Edgar Allan Poe",
    "blurb": "A visitor enters an old friend’s crumbling ancestral house. A Gothic tale of illness, fear, premature burial, and family tragedy.",
    "coverAsset": "Covers/poe_tales",
    "freeTier": false,
    "minimumVersion": "1.9.15 build 81",
    "title": "The Fall of the House of Usher"
  },
  "bedtime_fox_grapes_jacobs": {
    "author": "Aesop",
    "blurb": "Joseph Jacobs’s complete fable about disappointment and pretending not to want what is out of reach.",
    "coverAsset": "Covers/bedtime_fox_grapes_jacobs",
    "freeTier": true,
    "minimumVersion": "1.9.15 build 81",
    "title": "The Fox and the Grapes"
  },
  "bedtime_gibran_eye": {
    "author": "Kahlil Gibran",
    "blurb": "An eye sees a mountain that the other senses cannot confirm. A brief, complete parable about the limits of perspective.",
    "coverAsset": "Covers/gibran_madman",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Eye"
  },
  "bedtime_gibran_greater_sea": {
    "author": "Kahlil Gibran",
    "blurb": "A narrator and his soul search a shore for a place to bathe, encountering different ways of seeing the world. The complete parable.",
    "coverAsset": "Covers/gibran_madman",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Greater Sea"
  },
  "bedtime_gibran_scarecrow": {
    "author": "Kahlil Gibran",
    "blurb": "A brief, complete parable in which a scarecrow and a passer-by discuss their work and what gives it meaning.",
    "coverAsset": "Covers/gibran_madman",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Scarecrow"
  },
  "bedtime_gibran_seven_selves": {
    "author": "Kahlil Gibran",
    "blurb": "Seven inner selves question their roles in a man’s life. A complete parable about identity, longing, and the unoccupied self.",
    "coverAsset": "Covers/gibran_madman",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Seven Selves"
  },
  "bedtime_gibran_two_hermits": {
    "author": "Kahlil Gibran",
    "blurb": "Two hermits decide to divide their sole possession, a clay bowl. A brief, complete parable about attachment and conflict.",
    "coverAsset": "Covers/gibran_madman",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Two Hermits"
  },
  "bedtime_gibran_wise_king": {
    "author": "Kahlil Gibran",
    "blurb": "A changed well divides a king from his subjects. A brief, complete parable about conformity and the meaning of sanity.",
    "coverAsset": "Covers/gibran_madman",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Wise King"
  },
  "bedtime_goose_golden_eggs_jacobs": {
    "author": "Aesop",
    "blurb": "Joseph Jacobs’s complete fable about greed. A man kills his goose hoping to find gold inside, and loses his daily reward.",
    "coverAsset": "Covers/bedtime_goose_golden_eggs_jacobs",
    "freeTier": true,
    "minimumVersion": "1.9.15 build 81",
    "title": "The Goose That Laid the Golden Eggs"
  },
  "bedtime_gorgons_head": {
    "author": "Nathaniel Hawthorne",
    "blurb": "Perseus sets out to face Medusa with gifts from the gods. A complete Greek myth retold by Hawthorne, with threats, beheading, and people turned to stone.",
    "coverAsset": "Covers/bedtime_gorgons_head",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Gorgon’s Head"
  },
  "bedtime_great_bell": {
    "author": "Norman Hinsdale Pitman",
    "blurb": "Norman Hinsdale Pitman’s tragic legend of the great bell of Peking. A daughter sacrifices her life to save her father; includes threatened execution, fatal burning and grief.",
    "coverAsset": "Covers/bedtime_great_bell",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Great Bell"
  },
  "bedtime_grimm_hans_in_luck": {
    "author": "The Brothers Grimm",
    "blurb": "Hans trades away his wages on the journey home and finds happiness in an unexpected form.",
    "coverAsset": "Covers/grimms_fairy_tales",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "Hans In Luck"
  },
  "bedtime_grimm_iron_hans": {
    "author": "The Brothers Grimm",
    "blurb": "A boy frees a wild man and discovers a hidden source of help. Includes hunting, battles and danger.",
    "coverAsset": "Covers/grimms_fairy_tales",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "Iron Hans"
  },
  "bedtime_grimm_jorinda_and_jorindel": {
    "author": "The Brothers Grimm",
    "blurb": "A young man seeks the flower that can free Jorinda from an enchantress’s birdcage.",
    "coverAsset": "Covers/grimms_fairy_tales",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "Jorinda And Jorindel"
  },
  "bedtime_grimm_mother_holle": {
    "author": "The Brothers Grimm",
    "blurb": "Two sisters meet a mysterious woman beyond a well and receive very different rewards.",
    "coverAsset": "Covers/grimms_fairy_tales",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "Mother Holle"
  },
  "bedtime_grimm_old_sultan": {
    "author": "The Brothers Grimm",
    "blurb": "An ageing farm dog and a wolf make a bargain that ends in an unexpected showdown. Includes threats to kill the dog.",
    "coverAsset": "Covers/grimms_fairy_tales",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "Old Sultan"
  },
  "bedtime_grimm_snow_white_and_rose_red": {
    "author": "The Brothers Grimm",
    "blurb": "Two sisters befriend a bear and encounter an ungrateful dwarf. Includes violence and the dwarf’s death.",
    "coverAsset": "Covers/grimms_fairy_tales",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "Snow-White And Rose-Red"
  },
  "bedtime_grimm_the_blue_light": {
    "author": "The Brothers Grimm",
    "blurb": "A discharged soldier discovers a blue light and a powerful helper. Includes revenge, threats and executions.",
    "coverAsset": "Covers/grimms_fairy_tales",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Blue Light"
  },
  "bedtime_grimm_the_golden_goose": {
    "author": "The Brothers Grimm",
    "blurb": "A simple young man receives a golden goose, and everyone who touches it finds themselves stuck fast.",
    "coverAsset": "Covers/grimms_fairy_tales",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Golden Goose"
  },
  "bedtime_grimm_the_goose_girl": {
    "author": "The Brothers Grimm",
    "blurb": "A princess loses her identity to a false bride before a talking horse helps reveal the truth. Includes animal death and a violent punishment.",
    "coverAsset": "Covers/grimms_fairy_tales",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Goose-Girl"
  },
  "bedtime_grimm_the_queen_bee": {
    "author": "The Brothers Grimm",
    "blurb": "Kindness to ants, ducks and bees helps the youngest brother break a castle’s enchantment.",
    "coverAsset": "Covers/grimms_fairy_tales",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Queen Bee"
  },
  "bedtime_grimm_the_seven_ravens": {
    "author": "The Brothers Grimm",
    "blurb": "A girl journeys to the sun, moon and stars to rescue her seven enchanted brothers. Includes injury.",
    "coverAsset": "Covers/grimms_fairy_tales",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Seven Ravens"
  },
  "bedtime_grimm_the_straw_the_coal_and_the_bean": {
    "author": "The Brothers Grimm",
    "blurb": "Three unlikely companions escape a kitchen and try to cross a stream. Includes the deaths of two companions.",
    "coverAsset": "Covers/grimms_fairy_tales",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Straw, The Coal, And The Bean"
  },
  "bedtime_grimm_the_water_of_life": {
    "author": "The Brothers Grimm",
    "blurb": "Three princes seek a miraculous cure for their father. Includes betrayal and an attempted killing.",
    "coverAsset": "Covers/grimms_fairy_tales",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Water Of Life"
  },
  "bedtime_grimm_the_white_snake": {
    "author": "The Brothers Grimm",
    "blurb": "A servant who understands animals wins help in three seemingly impossible tasks. Includes threats of execution.",
    "coverAsset": "Covers/grimms_fairy_tales",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "The White Snake"
  },
  "bedtime_hare_tortoise_jacobs": {
    "author": "Aesop",
    "blurb": "A tiny fable about patience and a race, retold by Joseph Jacobs, with boasting and teasing.",
    "coverAsset": "Covers/bedtime_hare_tortoise_jacobs",
    "freeTier": true,
    "minimumVersion": "1.9.15 build 81",
    "title": "The Hare and the Tortoise"
  },
  "bedtime_idunas_apples": {
    "author": "Annie & Eliza Keary",
    "blurb": "When Idūna and her apples disappear, the gods of Asgard begin to age. This complete Norse tale includes abduction, a rescue, and a giant’s death by fire.",
    "coverAsset": "Covers/bedtime_idunas_apples",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "Idūna’s Apples"
  },
  "bedtime_indian_how_sun_moon_and_wind_went_out_to_dinner": {
    "author": "Joseph Jacobs",
    "blurb": "Three celestial siblings bring very different gifts home from a dinner with Thunder and Lightning.",
    "coverAsset": "Covers/bedtime_sun_moon_wind",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "How Sun, Moon, And Wind Went Out To Dinner"
  },
  "bedtime_indian_how_the_raja_s_son_won_the_princess_labam": {
    "author": "Joseph Jacobs",
    "blurb": "A prince’s kindness to animals helps him overcome the impossible tasks set by Princess Labam’s father.",
    "coverAsset": "Covers/indian_fairy_tales",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "How The Raja's Son Won The Princess Labam"
  },
  "bedtime_indian_the_broken_pot": {
    "author": "Joseph Jacobs",
    "blurb": "A man dreams of the fortune he will make from a pot of rice, until his daydream has a sudden consequence.",
    "coverAsset": "Covers/indian_fairy_tales",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Broken Pot"
  },
  "bedtime_indian_the_lion_and_the_crane": {
    "author": "Joseph Jacobs",
    "blurb": "A crane helps a lion with a bone stuck in his throat and learns the limits of gratitude.",
    "coverAsset": "Covers/indian_fairy_tales",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Lion And The Crane"
  },
  "bedtime_indian_the_magic_fiddle": {
    "author": "Joseph Jacobs",
    "blurb": "A young woman’s suffering is transformed into the music of a magical fiddle. Includes family cruelty.",
    "coverAsset": "Covers/indian_fairy_tales",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Magic Fiddle"
  },
  "bedtime_indian_the_talkative_tortoise": {
    "author": "Joseph Jacobs",
    "blurb": "A tortoise’s inability to remain silent turns a journey with two geese into a fatal lesson.",
    "coverAsset": "Covers/indian_fairy_tales",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Talkative Tortoise"
  },
  "bedtime_indian_the_tiger_the_brahman_and_the_jackal": {
    "author": "Joseph Jacobs",
    "blurb": "A grateful traveller releases a tiger, then needs a jackal’s cleverness to escape being eaten.",
    "coverAsset": "Covers/indian_fairy_tales",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Tiger, The Brahman, And The Jackal"
  },
  "bedtime_japanese_how_an_old_man_lost_his_wen": {
    "author": "Yei Theodora Ozaki",
    "blurb": "An old man dances with mountain demons; a jealous neighbour tries to repeat his good fortune.",
    "coverAsset": "Covers/japanese_fairy_tales",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "How An Old Man Lost His Wen"
  },
  "bedtime_japanese_momotaro_or_the_story_of_the_son_of_a_peach": {
    "author": "Yei Theodora Ozaki",
    "blurb": "A boy born from a peach sets out with animal companions to confront island ogres. Includes battle and violence.",
    "coverAsset": "Covers/bedtime_momotaro",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "Momotaro, Or The Story Of The Son Of A Peach"
  },
  "bedtime_japanese_the_adventures_of_kintaro_the_golden_boy": {
    "author": "Yei Theodora Ozaki",
    "blurb": "A child of extraordinary strength grows up among mountain animals before joining a warrior’s household.",
    "coverAsset": "Covers/bedtime_kintaro",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Adventures Of Kintaro, The Golden Boy"
  },
  "bedtime_japanese_the_bamboo_cutter_and_the_moon_child": {
    "author": "Yei Theodora Ozaki",
    "blurb": "An old bamboo-cutter discovers a luminous child whose true home lies beyond the earth. Includes separation and loss.",
    "coverAsset": "Covers/bedtime_bamboo_cutter",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Bamboo-Cutter And The Moon-Child"
  },
  "bedtime_japanese_the_mirror_of_matsuyama_a_story_of_old_japan": {
    "author": "Yei Theodora Ozaki",
    "blurb": "A treasured mirror helps a daughter remember her mother. Includes bereavement and family mistrust.",
    "coverAsset": "Covers/japanese_fairy_tales",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Mirror Of Matsuyama A Story Of Old Japan"
  },
  "bedtime_japanese_the_story_of_urashima_taro_the_fisher_lad": {
    "author": "Yei Theodora Ozaki",
    "blurb": "A fisherman visits a palace beneath the sea and returns to a world changed by time. Includes an irreversible loss and death.",
    "coverAsset": "Covers/bedtime_urashima_taro",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Story Of Urashima Taro, The Fisher Lad"
  },
  "bedtime_japanese_the_white_hare_and_the_crocodiles": {
    "author": "Yei Theodora Ozaki",
    "blurb": "A hare’s trick on a company of crocodiles leads to injury and a lesson in compassion.",
    "coverAsset": "Covers/japanese_fairy_tales",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "The White Hare And The Crocodiles"
  },
  "bedtime_ka_ngot_ka_iam": {
    "author": "Mrs. Rafy",
    "blurb": "Two daughters of the god of Shillong become rivers and race towards the plains. A complete Khasi legend retold by Mrs. Rafy, including its closing account of reverence for the rivers.",
    "coverAsset": "Covers/bedtime_ka_ngot_ka_iam",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Goddesses Ka Ngot and Ka Iam"
  },
  "bedtime_kintaro": {
    "author": "Yei Theodora Ozaki",
    "blurb": "A mountain child of extraordinary strength befriends the animals and finds his calling. Ozaki’s complete Japanese legend includes wrestling, a family’s hardship, and a happy reunion.",
    "coverAsset": "Covers/bedtime_kintaro",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "Kintaro, the Golden Boy"
  },
  "bedtime_lang_dapplegrim": {
    "author": "Andrew Lang",
    "blurb": "A youth and his extraordinary horse undertake impossible tasks to win a princess. Includes dangerous trials.",
    "coverAsset": "Covers/red_fairy_book",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "Dapplegrim"
  },
  "bedtime_lang_soria_moria_castle": {
    "author": "Andrew Lang",
    "blurb": "A young traveller reaches a castle ruled by trolls and helps three princesses. Includes violent battles.",
    "coverAsset": "Covers/red_fairy_book",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "Soria Moria Castle"
  },
  "bedtime_lang_spindle_shuttle_and_needle": {
    "author": "Brothers Grimm",
    "blurb": "A poor girl’s spindle, shuttle and needle help her welcome a prince without abandoning her work.",
    "coverAsset": "Covers/green_fairy_book",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "Spindle, Shuttle, And Needle"
  },
  "bedtime_lang_the_death_of_koshchei_the_deathless": {
    "author": "Andrew Lang",
    "blurb": "Prince Ivan pursues the deathless Koshchei to rescue Marya Morevna. Includes dismemberment, magical revival and death.",
    "coverAsset": "Covers/red_fairy_book",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Death Of Koshchei The Deathless"
  },
  "bedtime_lang_the_enchanted_pig": {
    "author": "Andrew Lang",
    "blurb": "A princess marries an enchanted pig and undertakes a long journey to recover her husband.",
    "coverAsset": "Covers/red_fairy_book",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Enchanted Pig"
  },
  "bedtime_lang_the_enchanted_watch": {
    "author": "Andrew Lang",
    "blurb": "A young man acquires a watch that grants wishes, then relies on his cat and dog to recover it. Includes a destructive revenge.",
    "coverAsset": "Covers/green_fairy_book",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Enchanted Watch"
  },
  "bedtime_lang_the_flying_ship": {
    "author": "Andrew Lang",
    "blurb": "A supposedly foolish son gathers companions with unusual powers to win a princess. Includes threatened violence.",
    "coverAsset": "Covers/yellow_fairy_book",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Flying Ship"
  },
  "bedtime_lang_the_flying_trunk": {
    "author": "Hans Christian Andersen",
    "blurb": "A merchant’s son flies to a distant kingdom in a magical trunk. Includes a broken courtship and an unhappy ending.",
    "coverAsset": "Covers/pink_fairy_book",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Flying Trunk"
  },
  "bedtime_lang_the_goblin_and_the_grocer": {
    "author": "Hans Christian Andersen",
    "blurb": "A goblin is torn between a grocer’s porridge and the poetry of a poor student.",
    "coverAsset": "Covers/pink_fairy_book",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Goblin And The Grocer"
  },
  "bedtime_lang_the_golden_crab": {
    "author": "Andrew Lang",
    "blurb": "A fisherman’s strange catch becomes an enchanted royal bridegroom.",
    "coverAsset": "Covers/yellow_fairy_book",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Golden Crab"
  },
  "bedtime_lang_the_grateful_prince": {
    "author": "Andrew Lang",
    "blurb": "A prince confronts a bargain his father made with a forest spirit. Includes danger, enchantment and sacrifice.",
    "coverAsset": "Covers/violet_fairy_book",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Grateful Prince"
  },
  "bedtime_lang_the_lute_player": {
    "author": "Andrew Lang",
    "blurb": "A queen travels in disguise with her lute to rescue a captive king.",
    "coverAsset": "Covers/violet_fairy_book",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Lute Player"
  },
  "bedtime_lang_the_master_maid": {
    "author": "Andrew Lang",
    "blurb": "A prince and a resourceful maid escape a giant with magical help. Includes pursuit, enchantment and a violent punishment.",
    "coverAsset": "Covers/blue_fairy_book",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Master-Maid"
  },
  "bedtime_lang_the_six_swans": {
    "author": "Brothers Grimm",
    "blurb": "A sister must remain silent while she makes shirts to free her brothers from a spell. Includes persecution and threatened execution.",
    "coverAsset": "Covers/yellow_fairy_book",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Six Swans"
  },
  "bedtime_lang_the_snow_man": {
    "author": "Hans Christian Andersen",
    "blurb": "A newly made snowman falls in love with a warm stove, unaware of what spring will bring. A wistful tale of impermanence.",
    "coverAsset": "Covers/pink_fairy_book",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Snow Man"
  },
  "bedtime_lang_the_story_of_caliph_stork": {
    "author": "Wilhelm Hauff",
    "blurb": "A caliph and his vizier become storks and must remember a forbidden word to regain their human forms.",
    "coverAsset": "Covers/green_fairy_book",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Story Of Caliph Stork"
  },
  "bedtime_lang_the_tinder_box": {
    "author": "Hans Christian Andersen",
    "blurb": "A soldier discovers a magical tinder-box and three remarkable dogs. Includes executions and violent revenge.",
    "coverAsset": "Covers/yellow_fairy_book",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Tinder-Box"
  },
  "bedtime_lang_the_two_frogs": {
    "author": "Andrew Lang",
    "blurb": "Two frogs set off to see each other’s cities and mistake their familiar view for a discovery.",
    "coverAsset": "Covers/violet_fairy_book",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Two Frogs"
  },
  "bedtime_lang_the_white_cat": {
    "author": "Madame d’Aulnoy",
    "blurb": "A prince visits an enchanted cat’s palace and finds help with his father’s impossible requests. Includes violent enchantment-breaking.",
    "coverAsset": "Covers/blue_fairy_book",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "The White Cat"
  },
  "bedtime_lang_the_wonderful_sheep": {
    "author": "Madame d’Aulnoy",
    "blurb": "An enchanted sheep offers a princess refuge, but a broken promise leads to a tragic ending.",
    "coverAsset": "Covers/blue_fairy_book",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Wonderful Sheep"
  },
  "bedtime_lang_why_the_sea_is_salt": {
    "author": "Andrew Lang",
    "blurb": "A magical mill brings wealth to a poor brother and explains the saltiness of the sea. Includes a sinking ship.",
    "coverAsset": "Covers/blue_fairy_book",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "Why The Sea Is Salt"
  },
  "bedtime_legend_knockmany": {
    "author": "Joseph Jacobs",
    "blurb": "An Irish giant legend in Joseph Jacobs’s collection. Oonagh helps Fin M’Coul outwit a rival; the comic trickery ends in a severed finger and death.",
    "coverAsset": "Covers/bedtime_legend_knockmany",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "A Legend of Knockmany"
  },
  "bedtime_lion_mouse_jacobs": {
    "author": "Aesop",
    "blurb": "Joseph Jacobs’s complete fable about kindness returned. A spared mouse later frees the lion; includes a threat to the mouse’s life.",
    "coverAsset": "Covers/bedtime_lion_mouse_jacobs",
    "freeTier": true,
    "minimumVersion": "1.9.15 build 81",
    "title": "The Lion and the Mouse"
  },
  "bedtime_masque_red_death": {
    "author": "Edgar Allan Poe",
    "blurb": "A prince shelters his guests behind sealed gates while a plague ravages the country. A Gothic allegory of disease, privilege, and mortality.",
    "coverAsset": "Covers/poe_tales",
    "freeTier": false,
    "minimumVersion": "1.9.15 build 81",
    "title": "The Masque of the Red Death"
  },
  "bedtime_maui_sun": {
    "author": "Rev. A. O. Forbes",
    "blurb": "Maui lassoes the sun to give his mother more time to dry her kapa. A complete Hawaiian legend contributed by Rev. A. O. Forbes, including its violent closing encounter with Moemoe. Includes threats, the breaking of the sun’s rays, and the killing of Moemoe.",
    "coverAsset": "Covers/bedtime_maui_sun",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "Maui Snares the Sun"
  },
  "bedtime_minotaur": {
    "author": "Nathaniel Hawthorne",
    "blurb": "Theseus travels to Crete and enters the labyrinth with Ariadne’s help. Hawthorne’s complete retelling includes violence, threatened sacrifice, and a father’s death.",
    "coverAsset": "Covers/bedtime_minotaur",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Minotaur"
  },
  "bedtime_miraculous_pitcher": {
    "author": "Nathaniel Hawthorne",
    "blurb": "Philemon and Baucis welcome two strangers to their humble home. A complete tale of hospitality and lasting affection, with cruel neighbours and a destructive flood.",
    "coverAsset": "Covers/bedtime_miraculous_pitcher",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Miraculous Pitcher"
  },
  "bedtime_momotaro": {
    "author": "Yei Theodora Ozaki",
    "blurb": "A boy found inside a peach sets out with a dog, a monkey, and a pheasant. Ozaki’s complete Japanese legend includes a sea journey and a battle with ogres.",
    "coverAsset": "Covers/bedtime_momotaro",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "Momotaro, the Peach Boy"
  },
  "bedtime_nesbit_beasts": {
    "author": "E. Nesbit",
    "blurb": "A young king opens a magical book and releases more than he expects. A complete tale of marvelous creatures and resourcefulness, with a destructive dragon and danger.",
    "coverAsset": "Covers/book_dragons",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Book of Beasts"
  },
  "bedtime_nesbit_deliverers": {
    "author": "E. Nesbit",
    "blurb": "Two children confront a country overrun by dragons. A complete comic adventure with fire, destruction and period national stereotypes.",
    "coverAsset": "Covers/book_dragons",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Deliverers of Their Country"
  },
  "bedtime_nesbit_dragon_tamers": {
    "author": "E. Nesbit",
    "blurb": "A dragon takes an unexpected place in a blacksmith’s household. A complete comic tale of bargains, work and family, with threats and violence.",
    "coverAsset": "Covers/book_dragons",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Dragon Tamers"
  },
  "bedtime_nesbit_fiery_dragon": {
    "author": "E. Nesbit",
    "blurb": "A young king’s kingdom and friendships face a fiery dragon. A complete magical adventure with mortal danger and cruelty.",
    "coverAsset": "Covers/book_dragons",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Fiery Dragon, or The Heart of Stone and the Heart of Gold"
  },
  "bedtime_nesbit_ice_dragon": {
    "author": "E. Nesbit",
    "blurb": "Two disobedient children venture into an icy world of dragons. A complete adventure with cold, fear and danger.",
    "coverAsset": "Covers/book_dragons",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Ice Dragon, or Do as You Are Told"
  },
  "bedtime_nesbit_kind_edmund": {
    "author": "E. Nesbit",
    "blurb": "An inquisitive boy searches underground and befriends a cockatrice. A complete comic tale with repeated corporal punishment, death and a bittersweet ending.",
    "coverAsset": "Covers/book_dragons",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "Kind Little Edmund, or The Caves and the Cockatrice"
  },
  "bedtime_nesbit_nine_whirlpools": {
    "author": "E. Nesbit",
    "blurb": "A princess, a magical island and nine whirlpools test a young hero. A complete fairy-tale adventure with captivity and danger.",
    "coverAsset": "Covers/book_dragons",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Island of the Nine Whirlpools"
  },
  "bedtime_nesbit_purple_stranger": {
    "author": "E. Nesbit",
    "blurb": "An unexpected purple visitor disrupts a family and their neighbourhood. A complete comic dragon tale with threats, captivity and peril.",
    "coverAsset": "Covers/book_dragons",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "Uncle James, or The Purple Stranger"
  },
  "bedtime_nightingale": {
    "author": "Andrew Lang",
    "blurb": "A living bird and a jeweled imitation at an emperor’s court. Includes threatened punishment, serious illness, and dated portrayals of China, with a hopeful recovery.",
    "coverAsset": "Covers/bedtime_nightingale",
    "freeTier": false,
    "minimumVersion": "1.9.15 build 81",
    "title": "The Nightingale"
  },
  "bedtime_norse_east_of_the_sun_and_west_of_the_moon": {
    "author": "Asbjørnsen & Moe",
    "blurb": "A young woman journeys beyond the four winds to rescue her enchanted prince. Includes captivity and the deaths of trolls.",
    "coverAsset": "Covers/east_of_sun",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "East Of The Sun And West Of The Moon"
  },
  "bedtime_norse_the_blue_belt": {
    "author": "Asbjørnsen & Moe",
    "blurb": "A poor boy finds a belt that gives him great strength. Includes betrayal, imprisonment and violent confrontations.",
    "coverAsset": "Covers/east_of_sun",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Blue Belt"
  },
  "bedtime_norse_the_giant_who_had_no_heart_in_his_body": {
    "author": "Asbjørnsen & Moe",
    "blurb": "The youngest of seven princes seeks the hidden heart of a giant. Includes enchantment and the giant’s death.",
    "coverAsset": "Covers/east_of_sun",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Giant Who Had No Heart In His Body"
  },
  "bedtime_norse_the_husband_who_was_to_mind_the_house": {
    "author": "Asbjørnsen & Moe",
    "blurb": "A husband takes over the household work and sets off a chain of comic disasters.",
    "coverAsset": "Covers/east_of_sun",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Husband Who Was To Mind The House"
  },
  "bedtime_norse_the_lad_who_went_to_the_north_wind": {
    "author": "Asbjørnsen & Moe",
    "blurb": "A boy asks the North Wind to replace his lost meal and receives three remarkable gifts. Includes a magical beating.",
    "coverAsset": "Covers/east_of_sun",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Lad Who Went To The North Wind"
  },
  "bedtime_norse_the_three_billy_goats_gruff": {
    "author": "Asbjørnsen & Moe",
    "blurb": "Three goats try to cross a bridge guarded by a hungry troll. Includes a violent defeat of the troll.",
    "coverAsset": "Covers/east_of_sun",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Three Billy-Goats Gruff"
  },
  "bedtime_north_wind_sun_jacobs": {
    "author": "Aesop",
    "blurb": "A tiny fable about persuasion and warmth, retold by Joseph Jacobs. Published as The Wind and the Sun.",
    "coverAsset": "Covers/bedtime_north_wind_sun_jacobs",
    "freeTier": true,
    "minimumVersion": "1.9.15 build 81",
    "title": "The North Wind and the Sun"
  },
  "bedtime_paradise_children": {
    "author": "Nathaniel Hawthorne",
    "blurb": "Pandora opens a mysterious box and discovers both trouble and hope. Hawthorne’s complete retelling includes quarrels, pain, and the arrival of sorrow.",
    "coverAsset": "Covers/bedtime_paradise_children",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Paradise of Children"
  },
  "bedtime_perrault_little_thumb": {
    "author": "Charles Perrault",
    "blurb": "A tiny boy saves his brothers with pebbles, cunning and seven-league boots. Includes abandonment and an ogre killing children.",
    "coverAsset": "Covers/perrault_tales",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "Little Thumb"
  },
  "bedtime_perrault_riquet_with_the_tuft": {
    "author": "Charles Perrault",
    "blurb": "A clever prince and a beautiful princess discover how affection changes their judgement of one another.",
    "coverAsset": "Covers/perrault_tales",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "Riquet With The Tuft"
  },
  "bedtime_perrault_the_fairy": {
    "author": "Charles Perrault",
    "blurb": "Two sisters meet a fairy at a spring and receive gifts that reveal their characters. Includes rejection and a death.",
    "coverAsset": "Covers/perrault_tales",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Fairy"
  },
  "bedtime_pit_pendulum": {
    "author": "Edgar Allan Poe",
    "blurb": "A prisoner confronts a succession of tortures in a dark chamber. Poe’s suspense story includes confinement, terror, and threatened execution.",
    "coverAsset": "Covers/poe_tales",
    "freeTier": false,
    "minimumVersion": "1.9.15 build 81",
    "title": "The Pit and the Pendulum"
  },
  "bedtime_pomegranate_seeds": {
    "author": "Nathaniel Hawthorne",
    "blurb": "Ceres searches for Proserpina after she is taken to the underworld. Hawthorne’s complete seasonal myth includes abduction, separation, and a reunion with conditions.",
    "coverAsset": "Covers/bedtime_pomegranate_seeds",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Pomegranate Seeds"
  },
  "bedtime_princess_kwan_yin": {
    "author": "Norman Hinsdale Pitman",
    "blurb": "Norman Hinsdale Pitman’s retelling of the Chinese legend of the Goddess of Mercy. Includes coercion, threatened fire, execution and transformation after death.",
    "coverAsset": "Covers/bedtime_princess_kwan_yin",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Princess Kwan-Yin"
  },
  "bedtime_raggedy_raggedy_ann_and_the_chickens": {
    "author": "Johnny Gruelle",
    "blurb": "Raggedy Ann’s visit to the chicken yard ends with two hens and a brood of chicks.",
    "coverAsset": "Covers/raggedy_ann",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "Raggedy Ann And The Chickens"
  },
  "bedtime_raggedy_raggedy_ann_and_the_kite": {
    "author": "Johnny Gruelle",
    "blurb": "Raggedy Ann is carried away by a kite and waits to be found. Includes a frightening separation.",
    "coverAsset": "Covers/raggedy_ann",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "Raggedy Ann And The Kite"
  },
  "bedtime_raggedy_raggedy_ann_and_the_kittens": {
    "author": "Johnny Gruelle",
    "blurb": "Raggedy Ann befriends a mother cat and helps the kittens find a welcome.",
    "coverAsset": "Covers/raggedy_ann",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "Raggedy Ann And The Kittens"
  },
  "bedtime_raggedy_raggedy_ann_and_the_mouse": {
    "author": "Johnny Gruelle",
    "blurb": "Raggedy Ann protects a mother mouse and makes peace with Boots the kitten.",
    "coverAsset": "Covers/raggedy_ann",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "Raggedy Ann And The Mouse"
  },
  "bedtime_raggedy_raggedy_ann_and_the_painter": {
    "author": "Johnny Gruelle",
    "blurb": "A painter’s accident leads to a new surprise inside Raggedy Ann.",
    "coverAsset": "Covers/raggedy_ann",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "Raggedy Ann And The Painter"
  },
  "bedtime_raggedy_raggedy_ann_and_the_washing": {
    "author": "Johnny Gruelle",
    "blurb": "A washing-day mishap leaves Raggedy Ann in need of repair, with a reassuring return home.",
    "coverAsset": "Covers/raggedy_ann",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "Raggedy Ann And The Washing"
  },
  "bedtime_raggedy_raggedy_ann_learns_a_lesson": {
    "author": "Johnny Gruelle",
    "blurb": "The dolls explore the pantry while their owner is away, and Raggedy Ann learns a lesson about care.",
    "coverAsset": "Covers/raggedy_ann",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "Raggedy Ann Learns A Lesson"
  },
  "bedtime_raggedy_raggedy_ann_rescues_fido": {
    "author": "Johnny Gruelle",
    "blurb": "The dolls set out at midnight to rescue Fido and bring him safely home.",
    "coverAsset": "Covers/raggedy_ann",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "Raggedy Ann Rescues Fido"
  },
  "bedtime_raggedy_raggedy_ann_s_trip_on_the_river": {
    "author": "Johnny Gruelle",
    "blurb": "A tea party turns into an unexpected river adventure. Includes rough play and a rescue.",
    "coverAsset": "Covers/raggedy_ann",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "Raggedy Ann's Trip On The River"
  },
  "bedtime_raja_rasalu": {
    "author": "Joseph Jacobs",
    "blurb": "A Punjabi hero legend in Joseph Jacobs’s collection, with animal helpers and a perilous game. Includes beheadings, a poisoned dog, threats to an infant and a historical child marriage.",
    "coverAsset": "Covers/bedtime_raja_rasalu",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "Raja Rasalu"
  },
  "bedtime_shipwrecked_sailor": {
    "author": "W. M. Flinders Petrie",
    "blurb": "A shipwrecked Egyptian sailor meets a great golden serpent on an enchanted island and waits for the promised voyage home. The complete tale in Petrie’s English rendering, including its framing exchange and scribe’s closing note. Includes shipwreck, loss of life and a threatening supernatural encounter.",
    "coverAsset": "Covers/bedtime_shipwrecked_sailor",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Shipwrecked Sailor"
  },
  "bedtime_sindbad_first_voyage": {
    "author": "Anonymous",
    "blurb": "Sindbad tells a weary porter how a seemingly peaceful island plunged beneath the waves, and how he found his way home. Includes the opening Hindbad frame and the complete first voyage. Includes peril at sea and historical references to enslaved people.",
    "coverAsset": "Covers/bedtime_sindbad_first_voyage",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "Sindbad’s First Voyage"
  },
  "bedtime_steadfast_tin_soldier": {
    "author": "Andrew Lang",
    "blurb": "A one-legged toy soldier’s journey and love for a paper dancer. Includes a dangerous fall, near-drowning, and a tragic ending in the fire.",
    "coverAsset": "Covers/bedtime_steadfast_tin_soldier",
    "freeTier": false,
    "minimumVersion": "1.9.15 build 81",
    "title": "The Steadfast Tin Soldier"
  },
  "bedtime_sun_moon_wind": {
    "author": "Joseph Jacobs",
    "blurb": "A short Indian origin myth in Joseph Jacobs’s collection. Moon remembers her mother after a feast; Sun and Wind receive curses for their selfishness.",
    "coverAsset": "Covers/bedtime_sun_moon_wind",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "How Sun, Moon, and Wind Went Out to Dinner"
  },
  "bedtime_thor_utgard": {
    "author": "Annie & Eliza Keary",
    "blurb": "Thor and Loki face a giant-king’s bewildering contests. The complete Utgard episode includes danger, animal slaughter and revival, and surprising feats of strength.",
    "coverAsset": "Covers/bedtime_thor_utgard",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "Thor’s Journey to Utgard"
  },
  "bedtime_three_golden_apples": {
    "author": "Nathaniel Hawthorne",
    "blurb": "Hercules seeks the apples of the Hesperides and meets Atlas. A complete Greek myth of strength and resourcefulness, with danger, a struggle, and deception.",
    "coverAsset": "Covers/bedtime_three_golden_apples",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Three Golden Apples"
  },
  "bedtime_thumbelina": {
    "author": "Andrew Lang",
    "blurb": "A tiny girl finds friendship and a home among flowers. Includes abduction, unwanted marriage plans, hunger, cold, and a butterfly left in danger.",
    "coverAsset": "Covers/bedtime_thumbelina",
    "freeTier": false,
    "minimumVersion": "1.9.15 build 81",
    "title": "Thumbelina"
  },
  "bedtime_tolstoy_coffee_house": {
    "author": "Leo Tolstoy",
    "blurb": "Travellers debate faith and knowledge in a coffee-house. The complete tale retains Tolstoy’s credit to Bernardin de Saint-Pierre.",
    "coverAsset": "Covers/tolstoy_what_men_live_by",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Coffee-House of Surat"
  },
  "bedtime_tolstoy_how_much_land": {
    "author": "Leo Tolstoy",
    "blurb": "A peasant’s desire for more land leads to a fateful bargain. The complete tale considers ambition, greed, and mortality.",
    "coverAsset": "Covers/tolstoy_what_men_live_by",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "How Much Land Does a Man Need?"
  },
  "bedtime_tolstoy_three_questions": {
    "author": "Leo Tolstoy",
    "blurb": "A king seeks the right time to act, the right people to heed, and the most important thing to do. A complete philosophical tale.",
    "coverAsset": "Covers/tolstoy_what_men_live_by",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "Three Questions"
  },
  "bedtime_tolstoy_what_men_live_by": {
    "author": "Leo Tolstoy",
    "blurb": "A shoemaker welcomes a stranger whose quiet presence transforms his household. The complete tale includes its six biblical epigraphs.",
    "coverAsset": "Covers/tolstoy_what_men_live_by",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "What Men Live By"
  },
  "bedtime_urashima_taro": {
    "author": "Yei Theodora Ozaki",
    "blurb": "A fisherman’s kindness leads him to a palace beneath the sea. Ozaki’s complete Japanese legend includes lost time, bereavement, and a sorrowful ending.",
    "coverAsset": "Covers/bedtime_urashima_taro",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "Urashima Taro"
  },
  "bedtime_vasilissa_fair": {
    "author": "W. R. S. Ralston",
    "blurb": "A Russian folktale in W. R. S. Ralston’s version, with a magical doll and Baba Yaga’s fire. Includes threats to eat a child and the fiery deaths of a stepmother and stepsisters. Ralston’s abridged concluding account is included.",
    "coverAsset": "Covers/bedtime_vasilissa_fair",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "Vasilissa the Fair"
  },
  "bedtime_wells_miracles": {
    "author": "H. G. Wells",
    "blurb": "An ordinary clerk discovers extraordinary powers. A complete speculative comedy whose experiments have catastrophic consequences.",
    "coverAsset": "Covers/tales_space_time",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Man Who Could Work Miracles"
  },
  "bedtime_wells_star": {
    "author": "H. G. Wells",
    "blurb": "A wandering star threatens Earth. The complete short story, with global catastrophe and a distant change of perspective.",
    "coverAsset": "Covers/tales_space_time",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Star"
  },
  "bedtime_wilde_the_birthday_of_the_infanta": {
    "author": "Oscar Wilde",
    "blurb": "A royal birthday entertainment becomes a cruel tragedy. Includes ridicule, rejection and a broken-hearted death.",
    "coverAsset": "Covers/wilde_pomegranates",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Birthday Of The Infanta"
  },
  "bedtime_wilde_the_devoted_friend": {
    "author": "Oscar Wilde",
    "blurb": "A linnet tells a water-rat about a gardener and a selfish miller. Includes exploitation and a drowning.",
    "coverAsset": "Covers/wilde_happy_prince",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Devoted Friend"
  },
  "bedtime_wilde_the_fisherman_and_his_soul": {
    "author": "Oscar Wilde",
    "blurb": "A fisherman gives up his soul to love a mermaid. Includes temptation, violence, religious conflict and death.",
    "coverAsset": "Covers/wilde_pomegranates",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Fisherman And His Soul"
  },
  "bedtime_wilde_the_remarkable_rocket": {
    "author": "Oscar Wilde",
    "blurb": "A self-important firework waits for a magnificent audience in this comic tale of vanity.",
    "coverAsset": "Covers/wilde_happy_prince",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Remarkable Rocket"
  },
  "bedtime_wilde_the_star_child": {
    "author": "Oscar Wilde",
    "blurb": "A beautiful but cruel child is transformed and must learn compassion. Includes abandonment, abuse and a bittersweet ending.",
    "coverAsset": "Covers/wilde_pomegranates",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Star-Child"
  },
  "bedtime_wilde_the_young_king": {
    "author": "Oscar Wilde",
    "blurb": "On the eve of his coronation, a young king dreams about the suffering behind his splendid robes. Includes forced labour and death.",
    "coverAsset": "Covers/wilde_pomegranates",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Young King"
  },
  "bedtime_wooing_olwen": {
    "author": "Joseph Jacobs",
    "blurb": "A Welsh Arthurian quest retold by Joseph Jacobs, with ancient talking animals and impossible tasks. Includes battle, bodily injury and a beheading.",
    "coverAsset": "Covers/bedtime_wooing_olwen",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Wooing of Olwen"
  },
  "benjamin_bunny": {
    "author": "Beatrix Potter",
    "blurb": "Benjamin and Peter return to Mr. McGregor’s garden to recover Peter’s clothes. A cat traps them beneath a basket before a noisy rescue. The complete original tale includes a spanking.",
    "coverAsset": "Covers/benjamin_bunny",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Tale of Benjamin Bunny"
  },
  "bhagavad_gita": {
    "author": "Traditional Hindu scripture",
    "blurb": "Facing battle, Arjuna questions Krishna about action, duty, devotion, and liberation. Presented in Edwin Arnold’s historical verse version, The Song Celestial.",
    "coverAsset": "Covers/bhagavad_gita",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "Bhagavad Gita"
  },
  "book_dragons": {
    "author": "E. Nesbit",
    "blurb": "Eight inventive dragon stories mix children, kingdoms, mischievous magic and unlikely solutions. Also available as individual tales. Includes peril, violence and period attitudes.",
    "coverAsset": "Covers/book_dragons",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Book of Dragons"
  },
  "book_tea": {
    "author": "Kakuzō Okakura",
    "blurb": "Tea opens a door to reflections on beauty, simplicity, art, and everyday rituals. Okakura moves between East and West in seven thoughtful chapters.",
    "coverAsset": "Covers/book_tea",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Book of Tea"
  },
  "book_wonder": {
    "author": "Lord Dunsany",
    "blurb": "Fourteen fantastical tales visit impossible cities, peculiar gods and the edges of the known world. Includes dark irony, violence and unsettling endings; each story is also available separately.",
    "coverAsset": "Covers/book_wonder",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Book of Wonder"
  },
  "carmilla": {
    "author": "J. Sheridan Le Fanu",
    "blurb": "A mysterious guest arrives at an isolated castle in Styria, bringing an intense friendship and a growing sense of dread. Le Fanu’s Gothic vampire novella entwines fascination, illness, and fear.",
    "coverAsset": "Covers/carmilla",
    "freeTier": false,
    "minimumVersion": "1.9.15 build 81",
    "title": "Carmilla"
  },
  "cicero_friendship_old_age": {
    "author": "Cicero",
    "blurb": "Two conversations consider loyal friendship, the pleasures of learning, growing older, and facing mortality. Cicero brings everyday examples to enduring questions.",
    "coverAsset": "Covers/cicero_friendship_old_age",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "On Friendship and Old Age"
  },
  "coming_race": {
    "author": "Edward Bulwer-Lytton",
    "blurb": "An explorer discovers an underground civilisation whose mysterious power, vril, has transformed daily life. Its apparent harmony conceals an unsettling vision of humanity’s future.",
    "coverAsset": "Covers/coming_race",
    "freeTier": false,
    "minimumVersion": "1.9.15 build 81",
    "title": "The Coming Race"
  },
  "connecticut_yankee": {
    "author": "Mark Twain",
    "blurb": "A nineteenth-century mechanic awakens in Arthurian Britain and tries to remake the kingdom with modern inventions. Twain’s satire turns from comic anachronisms to slavery, disease, warfare, and loss.",
    "coverAsset": "Covers/connecticut_yankee",
    "freeTier": false,
    "minimumVersion": "1.9.15 build 81",
    "title": "A Connecticut Yankee in King Arthur’s Court"
  },
  "crime_punishment": {
    "author": "Fyodor Dostoyevsky",
    "blurb": "After a desperate student commits murder in Saint Petersburg, guilt, pride, and compassion reshape his life. A psychological novel of moral struggle, suffering, and the possibility of renewal.",
    "coverAsset": "Covers/crime_punishment",
    "freeTier": false,
    "minimumVersion": "1.9.15 build 81",
    "title": "Crime and Punishment"
  },
  "crito": {
    "author": "Plato",
    "blurb": "Awaiting execution, Socrates receives a friend who urges him to escape. Their conversation weighs justice, conscience, friendship, and the claims of the law.",
    "coverAsset": "Covers/crito",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "Crito"
  },
  "dhammapada": {
    "author": "Traditional Buddhist scripture",
    "blurb": "Brief Buddhist verses reflect on attention, kindness, anger, desire, and the path of wisdom. Includes all 423 verses in twenty-six chapters.",
    "coverAsset": "Covers/dhammapada",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Dhammapada"
  },
  "discourse_method": {
    "author": "René Descartes",
    "blurb": "Descartes tells how he began questioning inherited beliefs and searching for a dependable way to reason. A personal journey through doubt, knowledge, and the examined life.",
    "coverAsset": "Covers/discourse_method",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "Discourse on Method"
  },
  "doctor_thorne": {
    "author": "Anthony Trollope",
    "blurb": "Mary Thorne and Frank Gresham face family pride, money worries, and an uncertain inheritance in rural Barsetshire. A witty courtship novel with alcoholism, illness, and death.",
    "coverAsset": "Covers/doctor_thorne",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "Doctor Thorne"
  },
  "egyptian_tales_first_series": {
    "author": "W. M. Flinders Petrie",
    "blurb": "Ancient Egyptian tales of royal magicians, shipwreck and exile in W. M. Flinders Petrie’s English rendering, with his introduction and historical remarks.",
    "coverAsset": "Covers/egyptian_tales_first_series",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "Egyptian Tales: First Series"
  },
  "enchanted_castle": {
    "author": "E. Nesbit",
    "blurb": "Three children discover a magical ring in an English country-house garden. Living statues and wishes gone awry turn their holiday into an adventure, with moments of danger and frightening transformation.",
    "coverAsset": "Covers/enchanted_castle",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Enchanted Castle"
  },
  "evelina": {
    "author": "Fanny Burney",
    "blurb": "A sheltered young woman enters London society, meeting awkward suitors and searching for affection and belonging. A lively novel in letters with harassment, humiliation, and family conflict.",
    "coverAsset": "Covers/evelina",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "Evelina"
  },
  "finnish_legends": {
    "author": "R. Eivind",
    "blurb": "A fireside retelling of the Kalevala: Väinämöinen’s songs, the forging of the Sampo, and journeys to the Northland. Includes conflict, loss, and wonder.",
    "coverAsset": "Covers/finnish_legends",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "Finnish Legends for English Children"
  },
  "first_men_moon": {
    "author": "H. G. Wells",
    "blurb": "An eccentric inventor and an ambitious businessman travel to the Moon and find a strange underground civilization. Scientific wonder and satire, with captivity and violence.",
    "coverAsset": "Covers/first_men_moon",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "The First Men in the Moon"
  },
  "first_summer_sierra": {
    "author": "John Muir",
    "blurb": "Muir follows a flock of sheep into the Sierra Nevada, recording wildflowers, forests, waterfalls and mountain weather. His complete summer journal includes animal deaths, dangerous climbs and prejudiced descriptions of Indigenous people.",
    "coverAsset": "Covers/first_summer_sierra",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "My First Summer in the Sierra"
  },
  "flatland": {
    "author": "Edwin Abbott Abbott",
    "blurb": "A square in a two-dimensional world encounters a dimension he cannot imagine. Abbott’s mathematical satire explores perception and social hierarchy, with deliberately oppressive views of class and women. Text edition; geometric illustrations are not included.",
    "coverAsset": "Covers/flatland",
    "freeTier": true,
    "minimumVersion": "1.9.15 build 81",
    "title": "Flatland"
  },
  "gibran_madman": {
    "author": "Kahlil Gibran",
    "blurb": "Brief parables and poems use masks, kings, hermits, animals, and imagined worlds to question belonging, certainty, loneliness, and freedom.",
    "coverAsset": "Covers/gibran_madman",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Madman"
  },
  "girl_limberlost": {
    "author": "Gene Stratton-Porter",
    "blurb": "Elnora earns her education by collecting moths in an Indiana wetland, then finds a complicated first love. A nature-rich coming-of-age story with parental neglect, grief, and romantic jealousy.",
    "coverAsset": "Covers/girl_limberlost",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "A Girl of the Limberlost"
  },
  "hawaiian_folk_tales": {
    "author": "Thomas G. Thrum",
    "blurb": "Maui, Pele, the Menehune, and island gods in a 1907 collection of Hawaiian legends. Includes danger, loss, and supernatural encounters.",
    "coverAsset": "Covers/hawaiian_folk_tales",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "Hawaiian Folk Tales"
  },
  "he_fell_in_love": {
    "author": "Edward Payson Roe",
    "blurb": "A lonely widower and a woman rebuilding her life enter a practical marriage that slowly becomes affectionate. A rural second-chance romance with grief, deception, violence, and dated ethnic stereotypes.",
    "coverAsset": "Covers/he_fell_in_love",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "He Fell in Love with His Wife"
  },
  "herland": {
    "author": "Charlotte Perkins Gilman",
    "blurb": "Three explorers encounter a society of women whose customs challenge their assumptions about family, education and power. A speculative satire with coercion and period prejudices.",
    "coverAsset": "Covers/herland",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "Herland"
  },
  "irish_fairy_tales": {
    "author": "James Stephens",
    "blurb": "Fionn, the Shee, and slow green magic told the Irish way.",
    "coverAsset": "Covers/irish_fairy_tales",
    "freeTier": false,
    "minimumVersion": "1.9.15 build 81",
    "title": "Irish Fairy Tales"
  },
  "khasi_folk_tales": {
    "author": "Mrs. Rafy",
    "blurb": "Sky-reaching trees, river goddesses, talking animals, and U Raitong’s flute in a 1920 collection of thirty-two Khasi tales.",
    "coverAsset": "Covers/khasi_folk_tales",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "Folk-Tales of the Khasis"
  },
  "king_elfland_daughter": {
    "author": "Lord Dunsany",
    "blurb": "A mortal lord brings an elven princess across the border of magic, entwining their family and the land of Erl with timeless Elfland. A lyrical fantasy of longing and separation, with hunting and violence.",
    "coverAsset": "Covers/king_elfland_daughter",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "The King of Elfland’s Daughter"
  },
  "last_man": {
    "author": "Mary Shelley",
    "blurb": "In a future England, Lionel Verney’s friendships and political hopes give way to a devastating worldwide plague. Shelley’s novel follows love, bereavement, and the loneliness of survival.",
    "coverAsset": "Covers/last_man",
    "freeTier": false,
    "minimumVersion": "1.9.15 build 81",
    "title": "The Last Man"
  },
  "lilith": {
    "author": "George MacDonald",
    "blurb": "A library mirror leads a young man into a strange world of ravens, living shadows and spiritual transformation. An adult visionary fantasy with disturbing imagery, violence and death.",
    "coverAsset": "Covers/lilith",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "Lilith"
  },
  "looking_backward": {
    "author": "Edward Bellamy",
    "blurb": "A man falls asleep in nineteenth-century Boston and wakes in the year 2000. Bellamy’s imagined future turns a stranger’s questions into a portrait of a radically changed society.",
    "coverAsset": "Covers/looking_backward",
    "freeTier": true,
    "minimumVersion": "1.9.15 build 81",
    "title": "Looking Backward"
  },
  "man_thinketh": {
    "author": "James Allen",
    "blurb": "An early New Thought work on character, purpose, and self-discipline, including period claims about health and circumstance. Its closing chapter reflects on serenity.",
    "coverAsset": "Covers/man_thinketh",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "As a Man Thinketh"
  },
  "miss_marjoribanks": {
    "author": "Margaret Oliphant",
    "blurb": "Lucilla sets out to organize Carlingford society, navigating dinner parties, ambition, and the marriage market. A social comedy with a romantic resolution, bereavement, and financial reversals.",
    "coverAsset": "Covers/miss_marjoribanks",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "Miss Marjoribanks"
  },
  "mizora": {
    "author": "Mary E. Bradley Lane",
    "blurb": "A Russian exile discovers an advanced society beneath the earth. An early feminist utopia with imagined science, grief, racial hierarchy and eugenic ideas.",
    "coverAsset": "Covers/mizora",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "Mizora: A Prophecy"
  },
  "moon_pool": {
    "author": "Abraham Merritt",
    "blurb": "A botanist follows a mysterious light into a hidden world beneath Pacific ruins. A scientific fantasy with ancient powers, danger, sacrifice and horror.",
    "coverAsset": "Covers/moon_pool",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Moon Pool"
  },
  "mrs_tiggy_winkle": {
    "author": "Beatrix Potter",
    "blurb": "Lucie follows a hillside path to a tiny washerwoman’s kitchen. Tea, freshly ironed animal clothes and a mysterious hedgehog fill Potter’s complete countryside tale.",
    "coverAsset": "Covers/mrs_tiggy_winkle",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Tale of Mrs. Tiggy-Winkle"
  },
  "my_antonia": {
    "author": "Willa Cather",
    "blurb": "Jim Burden recalls Ántonia Shimerda and the immigrant families of the Nebraska prairie. Cather's novel follows friendship, work, memory, hardship, and endurance, with bereavement and suicide.",
    "coverAsset": "Covers/my_antonia",
    "freeTier": false,
    "minimumVersion": "1.9.15 build 81",
    "title": "My Ántonia"
  },
  "nicomachean_ethics": {
    "author": "Aristotle",
    "blurb": "Aristotle asks what it means to live well, exploring character, friendship, pleasure, practical wisdom, and happiness across ten books.",
    "coverAsset": "Covers/nicomachean_ethics",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "Nicomachean Ethics"
  },
  "old_world_japan": {
    "author": "Frank Rinder",
    "blurb": "Japanese gods and legends: the sun goddess, the eight-headed serpent, enchanted islands, and supernatural encounters. A nineteenth-century retelling.",
    "coverAsset": "Covers/old_world_japan",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "Old-World Japan"
  },
  "on_benefits": {
    "author": "Seneca",
    "blurb": "Seneca examines generosity, gratitude, obligation, and the spirit behind a gift. Seven books of Stoic reflection include examples drawn from Roman society and its hierarchies.",
    "coverAsset": "Covers/on_benefits",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "On Benefits"
  },
  "on_liberty": {
    "author": "John Stuart Mill",
    "blurb": "Mill asks how people can live freely together: when society may interfere, why dissent matters, and what individuality brings to a shared life.",
    "coverAsset": "Covers/on_liberty",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "On Liberty"
  },
  "ozma_oz": {
    "author": "L. Frank Baum",
    "blurb": "Dorothy, a talking hen and the mechanical Tiktok join Ozma on a rescue mission in the Land of Ev. Includes imprisonment, threats and frightening transformations.",
    "coverAsset": "Covers/ozma_oz",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "Ozma of Oz"
  },
  "patchwork_girl_oz": {
    "author": "L. Frank Baum",
    "blurb": "Scraps, a lively patchwork girl, joins Ojo and a glass cat on a quest to undo a magical accident. Includes captivity, danger and comic misadventures.",
    "coverAsset": "Covers/patchwork_girl_oz",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Patchwork Girl of Oz"
  },
  "peter_pan": {
    "author": "J. M. Barrie",
    "blurb": "Peter, Wendy, and Neverland's pirates, with danger and dated racial stereotypes.",
    "coverAsset": "Covers/peter_pan",
    "freeTier": true,
    "minimumVersion": "1.9.15 build 81",
    "title": "Peter Pan"
  },
  "phantastes": {
    "author": "George MacDonald",
    "blurb": "A young man wanders a dreamlike fairyland of enchanted woods, living marble and mysterious shadows. A lyrical adult fantasy of longing, loss and self-discovery, with embedded songs and poems.",
    "coverAsset": "Covers/phantastes",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "Phantastes"
  },
  "phantom_opera": {
    "author": "Gaston Leroux",
    "blurb": "A young singer, a masked stranger, and secrets beneath the Paris Opera. Leroux’s Gothic mystery entwines obsession and music with abduction, violence, and tragedy.",
    "coverAsset": "Covers/phantom_opera",
    "freeTier": false,
    "minimumVersion": "1.9.15 build 81",
    "title": "The Phantom of the Opera"
  },
  "phoenix_carpet": {
    "author": "E. Nesbit",
    "blurb": "A phoenix hatches from a curious egg, and four children discover that their new carpet can fly. The second adventure after Five Children and It includes fire, danger and period attitudes.",
    "coverAsset": "Covers/phoenix_carpet",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Phoenix and the Carpet"
  },
  "pinocchio_italian": {
    "author": "Carlo Collodi",
    "blurb": "Collodi’s mischievous wooden puppet sets out to become a real boy. This complete edition is in the original Italian. Optional on-device reading translations require iOS 18 or later.",
    "coverAsset": "Covers/pinocchio_italian",
    "freeTier": false,
    "minimumVersion": "1.9.15 build 81",
    "title": "Pinocchio (Italian)"
  },
  "princess_curdie": {
    "author": "George MacDonald",
    "blurb": "Curdie leaves the mines to help Princess Irene and her imperilled father in a kingdom corrupted by greed. The sequel to The Princess and the Goblin includes poisoning, violence and a dark final ending.",
    "coverAsset": "Covers/princess_curdie",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Princess and Curdie"
  },
  "princess_mars": {
    "author": "Edgar Rice Burroughs",
    "blurb": "John Carter reaches the desert world of Barsoom and becomes caught in its rivalries and battles. The first Mars adventure, with romance, violence and dated racial attitudes.",
    "coverAsset": "Covers/princess_mars",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "A Princess of Mars"
  },
  "rights_woman": {
    "author": "Mary Wollstonecraft",
    "blurb": "Wollstonecraft argues for women’s education, independence, and equal moral standing, challenging the customs that limit their lives and choices.",
    "coverAsset": "Covers/rights_woman",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "A Vindication of the Rights of Woman"
  },
  "rose_in_bloom": {
    "author": "Louisa May Alcott",
    "blurb": "Rose returns home determined to choose a useful life and a love of her own. A coming-of-age romance with friendship, family expectations, alcohol misuse, and bereavement.",
    "coverAsset": "Covers/rose_in_bloom",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "Rose in Bloom"
  },
  "russian_fairy_tales": {
    "author": "W. R. S. Ralston",
    "blurb": "A nineteenth-century collection of Russian folk and fairy tales, with Ralston’s commentary, embedded narratives and original notes. Includes witches, child peril, violence and death, and retains historical terminology and attitudes.",
    "coverAsset": "Covers/russian_fairy_tales",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "Russian Fairy Tales"
  },
  "sacred_daniel_lions": {
    "author": "World English Bible",
    "blurb": "Daniel’s steadfast prayer brings him into danger under a royal decree.",
    "coverAsset": "Covers/sacred_daniel_lions",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "Daniel in the Lions’ Den"
  },
  "sacred_david_goliath": {
    "author": "World English Bible",
    "blurb": "A young shepherd enters the Valley of Elah carrying a sling and five stones.",
    "coverAsset": "Covers/sacred_david_goliath",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "David and Goliath"
  },
  "sacred_esther": {
    "author": "World English Bible",
    "blurb": "A queen’s appeal at the Persian court places her people’s future in the balance.",
    "coverAsset": "Covers/sacred_esther",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "Esther"
  },
  "sacred_jonah": {
    "author": "World English Bible",
    "blurb": "A reluctant prophet’s sea journey leads to Nineveh and an unexpected lesson in compassion.",
    "coverAsset": "Covers/sacred_jonah",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "Jonah"
  },
  "sacred_joseph_brothers": {
    "author": "World English Bible",
    "blurb": "Dreams, betrayal, years in Egypt, and a family’s reunion during famine.",
    "coverAsset": "Covers/sacred_joseph_brothers",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "Joseph and His Brothers"
  },
  "sacred_moses_exodus": {
    "author": "World English Bible",
    "blurb": "Moses’s early life, the burning bush, the departure from Egypt, and the journey to Sinai.",
    "coverAsset": "Covers/sacred_moses_exodus",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "Moses and the Exodus"
  },
  "sacred_noah_flood": {
    "author": "World English Bible",
    "blurb": "An ark, a flood, a covenant, and the account of Noah’s later life.",
    "coverAsset": "Covers/sacred_noah_flood",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "Noah and the Flood"
  },
  "sacred_ruth": {
    "author": "World English Bible",
    "blurb": "Ruth stays beside Naomi and finds a new home among the harvest fields of Bethlehem.",
    "coverAsset": "Covers/sacred_ruth",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "Ruth and Naomi"
  },
  "scarlet_plague": {
    "author": "Jack London",
    "blurb": "Decades after a pandemic destroys industrial society, an old survivor tells children about the lost world. London’s short novel contains mass death, violence, enslavement, and dated racial and class attitudes.",
    "coverAsset": "Covers/scarlet_plague",
    "freeTier": false,
    "minimumVersion": "1.9.15 build 81",
    "title": "The Scarlet Plague"
  },
  "story_amulet": {
    "author": "E. Nesbit",
    "blurb": "Four children and the Psammead follow a broken amulet through ancient Egypt, Babylon, Atlantis and a possible future. Includes warfare, peril and period portrayals of other cultures.",
    "coverAsset": "Covers/story_amulet",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Story of the Amulet"
  },
  "study_scarlet": {
    "author": "Arthur Conan Doyle",
    "blurb": "Watson meets Sherlock Holmes, and a puzzling London murder leads back to a long pursuit across America. The first Holmes novel includes murder and hostile historical portrayals of Mormon communities.",
    "coverAsset": "Covers/study_scarlet",
    "freeTier": true,
    "minimumVersion": "1.9.15 build 81",
    "title": "A Study in Scarlet"
  },
  "symposium": {
    "author": "Plato",
    "blurb": "A gathering in Athens becomes a lively conversation about love, beauty, and desire. Includes Aristophanes’s story of divided souls and Socrates’s account of Diotima’s teaching.",
    "coverAsset": "Covers/symposium",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "Symposium"
  },
  "tales_space_time": {
    "author": "H. G. Wells",
    "blurb": "Five complete speculative tales: a mysterious crystal, a wandering star, prehistoric survival, a future city and a man who can perform miracles. Wonder, satire and catastrophe.",
    "coverAsset": "Covers/tales_space_time",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "Tales of Space and Time"
  },
  "tales_wonder": {
    "author": "Lord Dunsany",
    "blurb": "Nineteen short fantasies mix dream cities, ghosts, pirates and extraordinary journeys. Includes death, dark humour and period attitudes; each story is also available separately.",
    "coverAsset": "Covers/tales_wonder",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "Tales of Wonder"
  },
  "the_professor": {
    "author": "Charlotte Brontë",
    "blurb": "An English teacher starts again in Brussels, where professional rivalry gives way to a bond with a fellow teacher. A romance about work and independence, with jealousy and period religious prejudice.",
    "coverAsset": "Covers/the_professor",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Professor"
  },
  "thirty_nine_steps": {
    "author": "John Buchan",
    "blurb": "Accused of a murder he did not commit, Richard Hannay flees into the Scottish countryside. Disguises, coded clues, and a looming international plot drive this swift espionage adventure.",
    "coverAsset": "Covers/thirty_nine_steps",
    "freeTier": true,
    "minimumVersion": "1.9.15 build 81",
    "title": "The Thirty-Nine Steps"
  },
  "time_machine": {
    "author": "H. G. Wells",
    "blurb": "A Victorian inventor travels far into the future and discovers a divided humanity beneath an apparently peaceful world. Wells's short novel mixes wonder with menace.",
    "coverAsset": "Covers/time_machine",
    "freeTier": true,
    "minimumVersion": "1.9.15 build 81",
    "title": "The Time Machine"
  },
  "tolstoy_what_men_live_by": {
    "author": "Leo Tolstoy",
    "blurb": "Four philosophical tales explore compassion, ambition, faith, and what matters in a human life: What Men Live By, Three Questions, The Coffee-House of Surat, and How Much Land Does a Man Need?",
    "coverAsset": "Covers/tolstoy_what_men_live_by",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "What Men Live By and Other Tales"
  },
  "tom_kitten": {
    "author": "Beatrix Potter",
    "blurb": "Three kittens lose their best clothes while exploring a cottage garden, and passing ducks try on the outfits. Potter’s complete mischievous tale includes their mother smacking them.",
    "coverAsset": "Covers/tom_kitten",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Tale of Tom Kitten"
  },
  "turn_screw": {
    "author": "Henry James",
    "blurb": "A governess caring for two children at a remote country house becomes convinced that they are in danger. James’s ambiguous ghost story draws its suspense from secrecy, watchfulness, and doubt.",
    "coverAsset": "Covers/turn_screw",
    "freeTier": false,
    "minimumVersion": "1.9.15 build 81",
    "title": "The Turn of the Screw"
  },
  "volsungs": {
    "author": "Anonymous",
    "blurb": "Sigurd, Fafnir, Brynhild, and a fateful treasure in the old Norse saga and Edda lays. Heroic, violent, and tragic.",
    "coverAsset": "Covers/volsungs",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Story of the Volsungs and Niblungs"
  },
  "war_worlds": {
    "author": "H. G. Wells",
    "blurb": "Martian machines descend on Victorian England, scattering ordinary lives in a struggle to survive. A landmark invasion story with warfare, terror, and destruction.",
    "coverAsset": "Covers/war_worlds",
    "freeTier": false,
    "minimumVersion": "1.9.15 build 81",
    "title": "The War of the Worlds"
  },
  "west_african_folk_tales": {
    "author": "W. H. Barker & Cecilia Sinclair",
    "blurb": "Anansi’s tricks, animal fables, and magical encounters in thirty-six tales. A historical collection with humour, danger, and unexpected turns.",
    "coverAsset": "Covers/west_african_folk_tales",
    "freeTier": true,
    "minimumVersion": "1.9.16 build 82",
    "title": "West African Folk-Tales"
  },
  "woman_white": {
    "author": "Wilkie Collins",
    "blurb": "A drawing teacher meets a frightened woman on a moonlit road. Her appearance begins a mystery of hidden identities, forged evidence, and a conspiracy revealed through competing accounts.",
    "coverAsset": "Covers/woman_white",
    "freeTier": false,
    "minimumVersion": "1.9.15 build 81",
    "title": "The Woman in White"
  },
  "wood_beyond_world": {
    "author": "William Morris",
    "blurb": "A merchant’s son sails into an enchanted country of dangerous love and mysterious strangers. An early adult fantasy romance with betrayal, captivity and violence.",
    "coverAsset": "Covers/wood_beyond_world",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "The Wood Beyond the World"
  },
  "zhuangzi": {
    "author": "Zhuangzi",
    "blurb": "Dreams, animals, travellers, and unexpected teachers explore freedom, perspective, skill, and change in this Taoist classic.",
    "coverAsset": "Covers/zhuangzi",
    "freeTier": false,
    "minimumVersion": "1.9.16 build 82",
    "title": "Zhuangzi"
  }
};
  var base = window.nightshelfSharedBooks || {};
  var versioned = window.nightshelfVersionedSharedBooks || {};
  Object.keys(additions).forEach(function (id) {
    if (Object.prototype.hasOwnProperty.call(base, id) || Object.prototype.hasOwnProperty.call(versioned, id)) {
      throw new Error('Shared catalog has changed; regenerate the additive release records.');
    }
  });
  // One reviewed factual correction; preserve the collection context and every blurb.
  if (!Object.prototype.hasOwnProperty.call(base, 'bedtime_beauty_beast') ||
      base.bedtime_beauty_beast.author !== 'Andrew Lang') {
    throw new Error('Beauty and the Beast source credit changed; review the one-field correction.');
  }
  base.bedtime_beauty_beast.author = 'Madame de Villeneuve';
  Object.keys(additions).forEach(function (id) { versioned[id] = additions[id]; });
  window.nightshelfVersionedSharedBooks = versioned;
}());
