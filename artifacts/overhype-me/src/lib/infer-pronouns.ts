/**
 * Infer likely pronouns from a first name using a lookup table of common names.
 * Returns "he/him", "she/her", or null (no confident guess → leave blank).
 * This is a suggestion only — users always pick their own pronouns.
 */

const MALE_NAMES = new Set([
  "aaron","adam","alan","albert","alex","alexander","alfred","andrew","andy","anthony","antonio",
  "arthur","austin","ben","benjamin","bill","billy","bobby","brad","brandon","brian","bruce",
  "bryan","caleb","carl","carlos","charlie","chris","christian","christopher","chuck","clarence",
  "clayton","clifford","clinton","cody","cole","colin","conner","connor","craig","dale","dan",
  "daniel","dave","david","dean","dennis","derek","dominic","donald","douglas","drew","dustin",
  "dylan","earl","eddie","edgar","edward","eli","elijah","eric","ethan","evan","frank","fred",
  "freddie","gabriel","gary","george","gerald","glen","gordon","grant","greg","gregory","harold",
  "harry","henry","howard","hudson","hunter","ian","isaac","jack","jackson","jacob","james",
  "jason","jay","jeff","jeffrey","jeremy","jerry","jesse","joel","john","johnny","jonathan",
  "jordan","joseph","josh","joshua","julian","justin","keith","kenneth","kevin","kyle","lance",
  "larry","lawrence","leo","leonard","liam","logan","louis","lucas","luke","mark","martin",
  "matt","matthew","max","michael","mike","mitchell","morgan","nathan","nathaniel","neil","nicholas",
  "nick","noah","nolan","norman","oliver","oscar","owen","patrick","paul","peter","philip",
  "phillip","ralph","randy","raymond","richard","rick","riley","rob","robert","roger","roman",
  "ron","ronald","ross","ryan","sam","samuel","scott","sean","seth","simon","stephen","steve",
  "steven","taylor","thomas","tim","timothy","todd","tom","tony","travis","trevor","troy","tyler",
  "victor","vincent","walter","wayne","william","wyatt","zach","zachary","zane",
]);

const FEMALE_NAMES = new Set([
  "abby","abigail","ada","addison","alexis","alice","alicia","alison","allison","alyssa",
  "amanda","amber","amelia","amy","andrea","angela","anna","anne","ashley","audrey",
  "autumn","ava","barbara","becky","bella","beth","brittany","brooke","camille","carol",
  "caroline","cassandra","cassie","charlotte","chelsea","cheryl","chloe","christina","claire",
  "courtney","crystal","cynthia","daisy","dana","danielle","deborah","debra","diana","donna",
  "dorothy","elena","elise","eliza","elizabeth","ella","ellen","emily","emma","erin","eva",
  "evelyn","faith","felicia","fiona","frances","gabrielle","gemma","grace","hailey","hannah",
  "harper","hazel","heather","helen","holly","isabelle","jade","jamie","jane","janet","jasmine",
  "jenna","jennifer","jessica","jill","joanna","jocelyn","julia","julie","karen","kate",
  "katelyn","katherine","kathryn","katie","kayla","kelly","kim","kimberly","kristen","kristin",
  "laura","lauren","lea","leah","leslie","lily","linda","lisa","liz","lorraine","lucy",
  "madison","margaret","maria","megan","melanie","melissa","mia","michelle","miranda",
  "molly","monica","natalie","nichole","nicole","nina","nora","olivia","paige","patricia",
  "phoebe","rachel","rebecca","riley","rose","ruby","ruth","samantha","sandra","sara","sarah",
  "savannah","shannon","shelby","sierra","sophia","stephanie","sue","summer","susan","sydney",
  "tamara","taylor","tiffany","tina","tracey","tracy","trinity","vanessa","veronica","victoria",
  "violet","virginia","wendy","whitney","zoe","zoey",
]);

export function inferPronounsFromName(fullName: string): "he/him" | "she/her" | null {
  const firstName = fullName.trim().split(/\s+/)[0] ?? "";
  if (firstName.length < 2) return null;
  const key = firstName.toLowerCase();
  if (MALE_NAMES.has(key)) return "he/him";
  if (FEMALE_NAMES.has(key)) return "she/her";
  return null;
}
