import type { MediaItem } from '../types';

type Member = [title: string, year: number, tmdbId: number, imdbId: string, type?: 'series'];

interface FeaturedCollection {
  id: string;
  title: string;
  kind: 'franchise' | 'universe';
  aliases?: string;
  members: Member[];
}

export const featuredCollections: FeaturedCollection[] = [
  {
    id: 'marvel', title: 'Marvel Cinematic Universe', kind: 'universe', aliases: 'MCU',
    members: [
      ['Iron Man', 2008, 1726, 'tt0371746'],
      ['Captain America: The First Avenger', 2011, 1771, 'tt0458339'],
      ['The Avengers', 2012, 24428, 'tt0848228'],
      ['Guardians of the Galaxy', 2014, 118340, 'tt2015381'],
      ['Black Panther', 2018, 284054, 'tt1825683'],
      ['Avengers: Infinity War', 2018, 299536, 'tt4154756'],
      ['Avengers: Endgame', 2019, 299534, 'tt4154796'],
      ['WandaVision', 2021, 85271, 'tt9140560', 'series'],
      ['Loki', 2021, 84958, 'tt9140554', 'series'],
    ],
  },
  {
    id: 'star-wars', title: 'Star Wars Universe', kind: 'universe', aliases: 'Skywalker',
    members: [
      ['A New Hope', 1977, 11, 'tt0076759'],
      ['The Empire Strikes Back', 1980, 1891, 'tt0080684'],
      ['Return of the Jedi', 1983, 1892, 'tt0086190'],
      ['The Phantom Menace', 1999, 1893, 'tt0120915'],
      ['Attack of the Clones', 2002, 1894, 'tt0121765'],
      ['Revenge of the Sith', 2005, 1895, 'tt0121766'],
      ['The Force Awakens', 2015, 140607, 'tt2488496'],
      ['Rogue One: A Star Wars Story', 2016, 330459, 'tt3748528'],
      ['The Last Jedi', 2017, 181808, 'tt2527336'],
      ['Solo: A Star Wars Story', 2018, 348350, 'tt3778644'],
      ['The Mandalorian', 2019, 82856, 'tt8111088', 'series'],
      ['The Rise of Skywalker', 2019, 181812, 'tt2527338'],
      ['Andor', 2022, 83867, 'tt9253284', 'series'],
      ['Ahsoka', 2023, 114461, 'tt13622776', 'series'],
    ],
  },
  {
    id: 'dceu', title: 'DC Extended Universe', kind: 'universe', aliases: 'DCEU Justice League',
    members: [
      ['Man of Steel', 2013, 49521, 'tt0770828'],
      ['Batman v Superman: Dawn of Justice', 2016, 209112, 'tt2975590'],
      ['Suicide Squad', 2016, 297761, 'tt1386697'],
      ['Wonder Woman', 2017, 297762, 'tt0451279'],
      ['Justice League', 2017, 141052, 'tt0974015'],
      ['Aquaman', 2018, 297802, 'tt1477834'],
      ['Shazam!', 2019, 287947, 'tt0448115'],
      ['Birds of Prey', 2020, 495764, 'tt7713068'],
      ['Wonder Woman 1984', 2020, 464052, 'tt7126948'],
      ["Zack Snyder's Justice League", 2021, 791373, 'tt12361974'],
      ['The Suicide Squad', 2021, 436969, 'tt6334354'],
      ['Peacemaker', 2022, 110492, 'tt13146488', 'series'],
      ['Black Adam', 2022, 436270, 'tt6443346'],
      ['Shazam! Fury of the Gods', 2023, 594767, 'tt10151854'],
      ['The Flash', 2023, 298618, 'tt0439572'],
      ['Blue Beetle', 2023, 565770, 'tt9362930'],
      ['Aquaman and the Lost Kingdom', 2023, 572802, 'tt9663764'],
    ],
  },
  {
    id: 'middle-earth', title: 'Middle-earth', kind: 'universe', aliases: 'Tolkien Lord of the Rings LOTR Hobbit',
    members: [
      ['The Fellowship of the Ring', 2001, 120, 'tt0120737'],
      ['The Two Towers', 2002, 121, 'tt0167261'],
      ['The Return of the King', 2003, 122, 'tt0167260'],
      ['The Hobbit: An Unexpected Journey', 2012, 49051, 'tt0903624'],
      ['The Hobbit: The Desolation of Smaug', 2013, 57158, 'tt1170358'],
      ['The Hobbit: The Battle of the Five Armies', 2014, 122917, 'tt2310332'],
      ['The Lord of the Rings: The Rings of Power', 2022, 84773, 'tt7631058', 'series'],
    ],
  },
  {
    id: 'wizarding-world', title: 'Wizarding World', kind: 'universe', aliases: 'Harry Potter Fantastic Beasts',
    members: [
      ["Harry Potter and the Philosopher's Stone", 2001, 671, 'tt0241527'],
      ['Harry Potter and the Chamber of Secrets', 2002, 672, 'tt0295297'],
      ['Harry Potter and the Prisoner of Azkaban', 2004, 673, 'tt0304141'],
      ['Harry Potter and the Goblet of Fire', 2005, 674, 'tt0330373'],
      ['Harry Potter and the Order of the Phoenix', 2007, 675, 'tt0373889'],
      ['Harry Potter and the Half-Blood Prince', 2009, 767, 'tt0417741'],
      ['Harry Potter and the Deathly Hallows: Part 1', 2010, 12444, 'tt0926084'],
      ['Harry Potter and the Deathly Hallows: Part 2', 2011, 12445, 'tt1201607'],
      ['Fantastic Beasts and Where to Find Them', 2016, 259316, 'tt3183660'],
      ['Fantastic Beasts: The Crimes of Grindelwald', 2018, 338952, 'tt4123430'],
      ['Fantastic Beasts: The Secrets of Dumbledore', 2022, 338953, 'tt4123432'],
    ],
  },
  {
    id: 'breaking-bad', title: 'Breaking Bad Universe', kind: 'universe',
    members: [
      ['Breaking Bad', 2008, 1396, 'tt0903747', 'series'],
      ['Better Call Saul', 2015, 60059, 'tt3032476', 'series'],
      ['El Camino: A Breaking Bad Movie', 2019, 559969, 'tt9243946'],
    ],
  },
  {
    id: 'monsterverse', title: 'Monsterverse', kind: 'universe', aliases: 'Godzilla King Kong',
    members: [
      ['Godzilla', 2014, 124905, 'tt0831387'],
      ['Kong: Skull Island', 2017, 293167, 'tt3731562'],
      ['Godzilla: King of the Monsters', 2019, 373571, 'tt3741700'],
      ['Godzilla vs. Kong', 2021, 399566, 'tt5034838'],
      ['Monarch: Legacy of Monsters', 2023, 202411, 'tt17220216', 'series'],
      ['Godzilla x Kong: The New Empire', 2024, 823464, 'tt14539740'],
    ],
  },
  {
    id: 'jurassic', title: 'Jurassic Park & Jurassic World', kind: 'franchise',
    members: [
      ['Jurassic Park', 1993, 329, 'tt0107290'],
      ['The Lost World: Jurassic Park', 1997, 330, 'tt0119567'],
      ['Jurassic Park III', 2001, 331, 'tt0163025'],
      ['Jurassic World', 2015, 135397, 'tt0369610'],
      ['Jurassic World: Fallen Kingdom', 2018, 351286, 'tt4881806'],
      ['Jurassic World Dominion', 2022, 507086, 'tt8041270'],
      ['Jurassic World Rebirth', 2025, 1234821, 'tt31036941'],
    ],
  },
  {
    id: 'john-wick', title: 'John Wick', kind: 'universe',
    members: [
      ['John Wick', 2014, 245891, 'tt2911666'],
      ['John Wick: Chapter 2', 2017, 324552, 'tt4425200'],
      ['John Wick: Chapter 3 – Parabellum', 2019, 458156, 'tt6146586'],
      ['John Wick: Chapter 4', 2023, 603692, 'tt10366206'],
      ['The Continental: From the World of John Wick', 2023, 72710, 'tt6486762', 'series'],
      ['Ballerina', 2025, 541671, 'tt7181546'],
    ],
  },
  {
    id: 'matrix', title: 'The Matrix', kind: 'franchise',
    members: [
      ['The Matrix', 1999, 603, 'tt0133093'],
      ['The Matrix Reloaded', 2003, 604, 'tt0234215'],
      ['The Animatrix', 2003, 55931, 'tt0328832'],
      ['The Matrix Revolutions', 2003, 605, 'tt0242653'],
      ['The Matrix Resurrections', 2021, 624860, 'tt10838180'],
    ],
  },
  {
    id: 'conjuring', title: 'The Conjuring Universe', kind: 'universe', aliases: 'Annabelle The Nun',
    members: [
      ['The Conjuring', 2013, 138843, 'tt1457767'],
      ['Annabelle', 2014, 250546, 'tt3322940'],
      ['The Conjuring 2', 2016, 259693, 'tt3065204'],
      ['Annabelle: Creation', 2017, 396422, 'tt5140878'],
      ['The Nun', 2018, 439079, 'tt5814060'],
      ['Annabelle Comes Home', 2019, 521029, 'tt8350360'],
      ['The Conjuring: The Devil Made Me Do It', 2021, 423108, 'tt7069210'],
      ['The Nun II', 2023, 968051, 'tt10160976'],
      ['The Conjuring: Last Rites', 2025, 1038392, 'tt22898462'],
    ],
  },
  {
    id: 'back-to-the-future', title: 'Back to the Future', kind: 'franchise',
    members: [
      ['Back to the Future', 1985, 105, 'tt0088763'],
      ['Back to the Future Part II', 1989, 165, 'tt0096874'],
      ['Back to the Future Part III', 1990, 196, 'tt0099088'],
    ],
  },
];

export function collectionMember([title, year, tmdbId, imdbId, type]: Member): MediaItem {
  return {
    id: `tmdb:${tmdbId}`,
    tmdbId,
    imdbId,
    type: type ?? 'movie',
    title,
    year: String(year),
    overview: '',
    genres: [],
    poster: `https://images.metahub.space/poster/medium/${imdbId}/img`,
    source: 'tmdb',
  };
}
