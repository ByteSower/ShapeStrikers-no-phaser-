/**
 * Shape Strikers Web — Game Configuration
 * Ported from elemental_arena/src/config/GameConfig.ts
 */

// ─── Elements ────────────────────────────────────────────────────────────────
const Element = Object.freeze({
  FIRE:      'fire',
  ICE:       'ice',
  LIGHTNING: 'lightning',
  EARTH:     'earth',
  ARCANE:    'arcane',
  VOID:      'void',
});

const ELEMENT_EMOJI = {
  fire: '🔥', ice: '🧊', lightning: '⚡',
  earth: '🌍', arcane: '✨', void: '🕳️',
};

const ELEMENT_COLORS = {
  fire: '#ff4422', ice: '#44ccff', lightning: '#c8a000',
  earth: '#88cc44', arcane: '#bb44ff', void: '#7744aa',
};

// ─── Element Synergies ────────────────────────────────────────────────────────
const ELEMENT_SYNERGIES = [
  { element: 'fire',      requiredCount: 2, bonus: { stat: 'attack',  multiplier: 1.15 }, description: '2🔥: +15% ATK' },
  { element: 'fire',      requiredCount: 3, bonus: { stat: 'attack',  multiplier: 1.30 }, description: '3🔥: +25% ATK' },
  { element: 'ice',       requiredCount: 2, bonus: { stat: 'defense', multiplier: 1.15 }, description: '2🧊: +10% DEF' },
  { element: 'ice',       requiredCount: 3, bonus: { stat: 'defense', multiplier: 1.30 }, description: '3🧊: +25% DEF' },
  { element: 'lightning', requiredCount: 2, bonus: { stat: 'speed',   multiplier: 1.20 }, description: '2⚡: +20% SPD' },
  { element: 'lightning', requiredCount: 3, bonus: { stat: 'speed',   multiplier: 1.40 }, description: '3⚡: +40% SPD' },
  { element: 'earth',     requiredCount: 2, bonus: { stat: 'hp',      multiplier: 1.20 }, description: '2🌍: +20% HP' },
  { element: 'earth',     requiredCount: 3, bonus: { stat: 'hp',      multiplier: 1.40 }, description: '3🌍: +35% HP' },
  { element: 'arcane',    requiredCount: 2, bonus: { stat: 'attack',  multiplier: 1.10 }, description: '2✨: +15% ATK' },
  { element: 'arcane',    requiredCount: 3, bonus: { stat: 'speed',   multiplier: 1.25 }, description: '3✨: +30% SPD' },
  { element: 'void',      requiredCount: 2, bonus: { stat: 'attack',  multiplier: 1.25 }, description: '2🕳️: +30% ATK' },
  { element: 'void',      requiredCount: 3, bonus: { stat: 'hp',      multiplier: 1.20 }, description: '3🕳️: +40% HP' },
];

// ─── Upgrades ─────────────────────────────────────────────────────────────────
const UPGRADES = [
  { id: 'army_expansion', name: '🏰 Army Expansion', description: '+1 max unit slot',          cost: 8, maxLevel: 5, effect: { type: 'maxUnits',         value: 1    } },
  { id: 'field_medic',    name: '💚 Field Medic',    description: '+15% post-battle healing',  cost: 5, maxLevel: 3, effect: { type: 'healingRate',       value: 0.15 } },
  { id: 'bargain_hunter', name: 'Hovs Handouts',     description: '-1 shop refresh cost(Stackable)',      cost: 4, maxLevel: 2, effect: { type: 'shopRefresh',       value: -1   } },
  { id: 'war_chest',      name: '📈 War Chest',      description: '+10% interest on gold(Stackable)',     cost: 6, maxLevel: 3, effect: { type: 'interestRate',      value: 0.1  } },
  { id: 'victory_bonus',  name: '🏆 Victory Bonus',  description: '+2 gold per wave won',      cost: 5, maxLevel: 3, effect: { type: 'goldPerWave',       value: 2    } },
  { id: 'refresh_master', name: '🔄 Refresh Master', description: '+1 refresh per round(Max 3)',      cost: 6, maxLevel: 2, effect: { type: 'refreshesPerRound', value: 1    } },
  { id: 'scouts_intel',   name: '🔭 Scout\'s Intel', description: 'See enemy details in wave preview', cost: 4, maxLevel: 2, effect: { type: 'scoutLevel',        value: 1    } },
  { id: 'elite_training', name: '⬆️ Elite Training', description: '+5% ATK & DEF to all units',       cost: 7, maxLevel: 3, effect: { type: 'statBonus',         value: 0.05 } },
  { id: 'mercenary',      name: '📜 Mercenary',      description: '+1 shop card per refresh',          cost: 6, maxLevel: 2, effect: { type: 'shopCards',          value: 1    } },
  { id: 'double_edge',    name: '⚔️ Double Edge',    description: '+20% ATK, −10% DEF all units',     cost: 5, maxLevel: 1, effect: { type: 'doubleEdge',        value: 1    } },
];

// ─── Achievements ─────────────────────────────────────────────────────────────
const ACHIEVEMENTS = [
  { id: 'first_victory',    name: 'First Victory',    icon: '🏆', description: 'Win the Normal Campaign' },
  { id: 'void_conqueror',   name: 'Void Conqueror',   icon: '🕳️', description: 'Win the Void Campaign' },
  { id: 'boss_slayer',      name: 'Boss Slayer',      icon: '👑', description: 'Defeat all 5 bosses across runs' },
  { id: 'full_army',        name: 'Full Army',        icon: '🏰', description: 'Fill all unit slots on the board' },
  { id: 'synergy_master',   name: 'Synergy Master',   icon: '🔗', description: 'Activate 3+ element synergies at once' },
  { id: 'untouchable',      name: 'Untouchable',      icon: '🛡️', description: 'Win a wave without losing any unit' },
  { id: 'speed_demon',      name: 'Speed Demon',      icon: '⚡', description: 'Win a battle on 4× speed' },
  { id: 'big_spender',      name: '💰 Big Spender',   icon: '💰', description: 'Buy 10+ upgrades in a single run' },
  { id: 'extinction',       name: 'Extinction',        icon: '💀', description: 'Kill 100+ enemies in a single run' },
  { id: 'flawless_run',     name: 'Flawless Run',     icon: '✨', description: 'Win the game without losing any unit' },
];

// ─── Challenge Modifiers (for Weekly Challenges) ──────────────────────────────
const CHALLENGE_MODIFIERS = [
  { id: 'inferno',        name: 'Inferno',        icon: '🔥', description: 'Only Fire units in the shop',        filter: 'fire' },
  { id: 'frozen_front',   name: 'Frozen Front',   icon: '❄️', description: 'Only Ice units in the shop',         filter: 'ice' },
  { id: 'no_mercy',       name: 'No Mercy',       icon: '💀', description: 'Healer units are banned from shop',  banRole: 'healer' },
  { id: 'glass_cannon',   name: 'Glass Cannon',   icon: '💥', description: '+50% ATK but −50% HP for all units', buff: 'glass_cannon' },
  { id: 'budget_run',     name: 'Penny Pincher',  icon: '🪙', description: 'Start with 5 gold, −30% gold income', economy: 'budget' },
  { id: 'fragile',        name: 'Fragile',        icon: '💔', description: 'All player units have −30% HP',       debuff: 'fragile' },
  { id: 'purity',         name: 'Purity',         icon: '✨', description: 'Only one random element available',   filter: 'single_element' },
  { id: 'titan_wave',     name: 'Titan Wave',     icon: '🗿', description: 'Enemies have +40% HP',               enemyBuff: 'titan' },
];

// ─── Unit Definitions ─────────────────────────────────────────────────────────
const UNIT_DEFINITIONS = [
  // ── TIER 1 ──────────────────────────────────────────────────────────────────
  {
    id: 'fire_imp', name: 'Flame Child Yun', element: 'fire', cost: 2, tier: 1, role: 'skirmisher',
    visual: { color: 'red', shape: 'circle' },
    stats: { hp: 80, maxHp: 80, attack: 15, defense: 5, speed: 8, range: 1 },
    ability: { name: 'Ember', description: 'Deals fire damage and applies burn', cooldown: 2 },
  },
  {
    id: 'ice_slime', name: 'Frost Slime Yon', element: 'ice', cost: 2, tier: 1, role: 'tank',
    visual: { color: 'blue', shape: 'circle' },
    stats: { hp: 100, maxHp: 100, attack: 10, defense: 8, speed: 4, range: 1 },
    ability: { name: 'Frost Blast', description: 'Slows nearby enemies', cooldown: 3 },
  },
  {
    id: 'earth_golem', name: 'Shape Golem Bofu', element: 'earth', cost: 2, tier: 1, role: 'tank',
    visual: { color: 'green', shape: 'square' },
    stats: { hp: 150, maxHp: 150, attack: 12, defense: 15, speed: 2, range: 1 },
    ability: { name: 'Stone Skin', description: 'Grants shield (bonus defense for 2 turns)', cooldown: 4 },
  },
  {
    id: 'lightning_sprite', name: 'Thundorian Child', element: 'lightning', cost: 2, tier: 1, role: 'sniper',
    visual: { color: 'yellow', shape: 'circle' },
    stats: { hp: 60, maxHp: 60, attack: 18, defense: 3, speed: 12, range: 2 },
    ability: { name: 'Chain Lightning', description: 'Bounces to 2 additional targets', cooldown: 3 },
  },
  {
    id: 'earth_archer', name: 'Scout Trooper Pebbles', element: 'earth', cost: 2, tier: 1, role: 'sniper',
    visual: { color: 'green', shape: 'rhombus' },
    stats: { hp: 90, maxHp: 90, attack: 14, defense: 10, speed: 5, range: 2 },
    ability: { name: 'Boulder Shot', description: 'Stuns target for 1 turn', cooldown: 3 },
  },
  {
    id: 'fire_scout', name: 'Flame Child Yunni', element: 'fire', cost: 2, tier: 1, role: 'skirmisher',
    visual: { color: 'red', shape: 'rhombus' },
    stats: { hp: 65, maxHp: 65, attack: 12, defense: 4, speed: 10, range: 2 },
    ability: { name: 'Fire Blast', description: 'Quick ranged attack with minor burn', cooldown: 2 },
  },
  {
    id: 'frost_fairy', name: 'Frost Fairy Yoko', element: 'ice', cost: 2, tier: 1, role: 'healer',
    visual: { color: 'blue', shape: 'square' },
    stats: { hp: 70, maxHp: 70, attack: 8, defense: 6, speed: 7, range: 2 },
    ability: { name: 'Frost Blessing', description: 'Heals lowest HP ally for 25 HP', cooldown: 2, healAmount: 25 },
  },
  {
    id: 'blood_sprite', name: 'Vamp Kid Yoi', element: 'fire', cost: 2, tier: 1, role: 'skirmisher', trait: 'vampire',
    visual: { color: 'pink', shape: 'circle' },
    stats: { hp: 75, maxHp: 75, attack: 14, defense: 5, speed: 7, range: 1 },
    ability: { name: 'Drain Bite', description: 'Drains enemy HP, healing self for 40% of damage', cooldown: 2 },
  },
  {
    id: 'konji_scout', name: 'Plague Son Yav', element: 'earth', cost: 2, tier: 1, role: 'sniper',
    visual: { color: 'yellow', shape: 'square' },
    stats: { hp: 70, maxHp: 70, attack: 12, defense: 6, speed: 8, range: 2 },
    ability: { name: 'Toxic Dart', description: 'Ranged attack that poisons target for 3 turns', cooldown: 2 },
  },
  {
    id: 'void_shade', name: 'Void Embryo Shadi', element: 'void', cost: 2, tier: 1, isVoid: true, role: 'skirmisher',
    visual: { color: 'pink', shape: 'circle' },
    stats: { hp: 60, maxHp: 60, attack: 18, defense: 3, speed: 10, range: 1 },
    ability: { name: 'Shadow Step', description: 'Becomes untargetable for 1 turn', cooldown: 3 },
  },  {
    id: 'arcane_pupil', name: 'Arcane Servant Qua', element: 'arcane', cost: 2, tier: 1, role: 'skirmisher',
    visual: { color: 'purple', shape: 'circle' },
    stats: { hp: 70, maxHp: 70, attack: 14, defense: 5, speed: 8, range: 1 },
    ability: { name: 'Arcane Bolt', description: 'Quick arcane attack; evolves over time (+ATK/DEF)', cooldown: 2 },
    evolveConfig: { interval: 3, statBonus: 0.1, maxStacks: 3 },
  },
  // ── TIER 2 ──────────────────────────────────────────────────────────────────
  {
    id: 'fire_warrior', name: 'Flame Soldier Magna', element: 'fire', cost: 4, tier: 2, role: 'tank',
    visual: { color: 'red', shape: 'squircle' },
    stats: { hp: 180, maxHp: 180, attack: 25, defense: 12, speed: 6, range: 1 },
    ability: { name: 'Blazing Dash', description: 'Dash forward, damages all enemies in same lane', cooldown: 3 },
  },
  {
    id: 'ice_archer', name: 'Ice Archer ColdShot', element: 'ice', cost: 4, tier: 2, role: 'sniper',
    visual: { color: 'blue', shape: 'squircle' },
    stats: { hp: 120, maxHp: 120, attack: 22, defense: 8, speed: 9, range: 3 },
    ability: { name: 'Frost Arrow', description: 'Piercing shot that freezes target', cooldown: 2 },
  },
  {
    id: 'arcane_mage', name: 'Arcane Descendant', element: 'arcane', cost: 4, tier: 2, role: 'caster',
    visual: { color: 'purple', shape: 'squircle' },
    stats: { hp: 100, maxHp: 100, attack: 30, defense: 5, speed: 7, range: 3 },
    ability: { name: 'Arcane Bomb', description: 'High damage magic attack', cooldown: 2 },
  },
  {
    id: 'lightning_knight', name: 'Thundorian Soldier', element: 'lightning', cost: 4, tier: 2, role: 'tank',
    visual: { color: 'yellow', shape: 'squircle' },
    stats: { hp: 160, maxHp: 160, attack: 20, defense: 14, speed: 8, range: 1 },
    ability: { name: 'Thunder ', description: 'Stuns target and deals bonus damage', cooldown: 3 },
  },
  {
    id: 'ice_guardian', name: 'Frost Guardian IceBur', element: 'ice', cost: 4, tier: 2, role: 'tank',
    visual: { color: 'blue', shape: 'squircle' },
    stats: { hp: 200, maxHp: 200, attack: 15, defense: 18, speed: 3, range: 1 },
    ability: { name: 'Frozen Wall', description: 'Grants shield (bonus defense for 3 turns) and slows all enemies', cooldown: 4 },
  },
  {
    id: 'arcane_assassin', name: 'Arcane Shadow', element: 'arcane', cost: 4, tier: 2, role: 'skirmisher',
    visual: { color: 'purple', shape: 'rhombus' },
    stats: { hp: 85, maxHp: 85, attack: 35, defense: 4, speed: 11, range: 2 },
    ability: { name: 'Shadow Strike', description: 'Critical hit with bonus damage', cooldown: 2 },
  },
  {
    id: 'nature_spirit', name: 'Shape Spirit Runi', element: 'earth', cost: 4, tier: 2, role: 'healer',
    visual: { color: 'green', shape: 'squircle' },
    stats: { hp: 120, maxHp: 120, attack: 10, defense: 12, speed: 5, range: 2 },
    ability: { name: 'Rejuvenate', description: 'Heals all allies for 15 HP', cooldown: 3, healAmount: 15 },
  },
  {
    id: 'arcane_priest', name: 'Arcane Sorcerer', element: 'arcane', cost: 4, tier: 2, role: 'healer',
    visual: { color: 'pink', shape: 'square' },
    stats: { hp: 100, maxHp: 100, attack: 15, defense: 8, speed: 6, range: 3 },
    ability: { name: 'Arcane Restoration', description: 'Heals lowest HP ally for 25 HP + grants shield', cooldown: 2, healAmount: 25 },
  },
  {
    id: 'blood_knight', name: 'Vamp General Parasect', element: 'fire', cost: 4, tier: 2, role: 'tank', trait: 'vampire',
    visual: { color: 'pink', shape: 'squircle' },
    stats: { hp: 170, maxHp: 170, attack: 24, defense: 10, speed: 6, range: 1 },
    ability: { name: 'Crimson Cleave', description: 'Cleaves adjacent enemies, heals 30% of total damage', cooldown: 3, maxTargets: 3 },
  },
  {
    id: 'konji_shaman', name: 'Plague Caster Fuu', element: 'earth', cost: 4, tier: 2, role: 'caster',
    visual: { color: 'green', shape: 'circle' },
    stats: { hp: 130, maxHp: 130, attack: 18, defense: 9, speed: 5, range: 2 },
    ability: { name: 'Plague Cloud', description: 'Poisons all enemies for 2 turns + minor damage', cooldown: 4 },
  },
  {
    id: 'void_knight', name: 'Void Berserker Zeku', element: 'void', cost: 4, tier: 2, isVoid: true, role: 'tank',
    visual: { color: 'purple', shape: 'circle' },
    stats: { hp: 180, maxHp: 180, attack: 28, defense: 10, speed: 6, range: 1 },
    ability: { name: 'Corruption Strike', description: 'Deals bonus damage and weakens target', cooldown: 3 },
  },
  {
    id: 'void_blighter', name: 'Void Curser Ukez', element: 'void', cost: 4, tier: 2, isVoid: true, role: 'caster',
    visual: { color: 'purple', shape: 'circle' },
    stats: { hp: 160, maxHp: 160, attack: 25, defense: 8, speed: 6, range: 2 },
    ability: { name: 'Cursed Wound', description: 'Applies Wound to enemies, reducing healing by 50%', cooldown: 3 },
  },  {
    id: 'earth_enforcer', name: 'Shape Enforcer Ooglong', element: 'earth', cost: 4, tier: 2, role: 'tank',
    visual: { color: 'green', shape: 'squircle' },
    stats: { hp: 160, maxHp: 160, attack: 22, defense: 14, speed: 5, range: 1 },
    ability: { name: 'Ground Slam', description: 'Heavy hit that knocks target back 1 row', cooldown: 3 },
  },
  {
    id: 'lightning_hunter', name: 'Thundorian Elite Danza', element: 'lightning', cost: 4, tier: 2, role: 'skirmisher',
    visual: { color: 'yellow', shape: 'rhombus' },
    stats: { hp: 110, maxHp: 110, attack: 24, defense: 6, speed: 10, range: 2 },
    ability: { name: 'Grapple Pull', description: 'Pulls target 1 row forward into danger', cooldown: 3 },
  },
  {
    id: 'fire_ravager', name: 'Inferno Ravager Rye', element: 'fire', cost: 4, tier: 2, role: 'skirmisher',
    visual: { color: 'red', shape: 'rhombus' },
    stats: { hp: 130, maxHp: 130, attack: 26, defense: 7, speed: 8, range: 1 },
    ability: { name: 'Rampage', description: 'Cleaves 2 targets; grows stronger with each kill', cooldown: 2 },
    killStackBonus: { atkPerKill: 0.1, maxBonus: 0.5 },
  },
  // ── TIER 3 ──────────────────────────────────────────────────────────────────
  {
    id: 'fire_demon', name: 'Daemon The Incinerator', element: 'fire', cost: 6, tier: 3, role: 'caster',
    visual: { color: 'red', shape: 'square' },
    stats: { hp: 200, maxHp: 200, attack: 30, defense: 12, speed: 5, range: 2 },
    ability: { name: 'Hellfire', description: 'Fire damage to up to 3 enemies in range', cooldown: 4, maxTargets: 3 },
  },
  {
    id: 'martial_master', name: 'Shape Boxer Tysr', element: 'earth', cost: 6, tier: 3, role: 'tank',
    visual: { color: 'green', shape: 'rhombus' },
    stats: { hp: 280, maxHp: 280, attack: 35, defense: 20, speed: 8, range: 1 },
    ability: { name: 'Thousand Fists', description: 'Multiple rapid strikes', cooldown: 3 },
  },
  {
    id: 'lightning_lord', name: 'Thundorian King Zesper', element: 'lightning', cost: 6, tier: 3, role: 'sniper',
    visual: { color: 'yellow', shape: 'rhombus' },
    stats: { hp: 180, maxHp: 180, attack: 45, defense: 10, speed: 10, range: 3 },
    ability: { name: 'Thunder Storm', description: 'Hits all enemies with chain lightning', cooldown: 4 },
  },
  {
    id: 'ice_empress', name: 'Ice Queen Elaine', element: 'ice', cost: 6, tier: 3, role: 'caster',
    visual: { color: 'blue', shape: 'rhombus' },
    stats: { hp: 220, maxHp: 220, attack: 32, defense: 16, speed: 6, range: 3 },
    ability: { name: 'Blizzard', description: 'Freezes and damages all enemies', cooldown: 5 },
  },
  {
    id: 'life_guardian', name: 'Shape Guardian Ari', element: 'earth', cost: 6, tier: 3, role: 'healer',
    visual: { color: 'green', shape: 'squircle' },
    stats: { hp: 200, maxHp: 200, attack: 12, defense: 18, speed: 4, range: 2 },
    ability: { name: "Guardian's Blessing", description: 'Heals all allies 30 HP + applies barrier', cooldown: 4, healAmount: 30 },
  },
  {
    id: 'void_horror', name: 'Void Horror Yui', element: 'void', cost: 6, tier: 3, isVoid: true, role: 'caster',
    visual: { color: 'pink', shape: 'rhombus' },
    stats: { hp: 300, maxHp: 300, attack: 38, defense: 12, speed: 4, range: 2 },
    ability: { name: 'Void Rupture', description: 'AoE dark damage that ignores defense', cooldown: 4 },
  },
  {
    id: 'arcane_illusionist', name: 'Arcane Illusionist Shera', element: 'arcane', cost: 6, tier: 3, role: 'caster',
    visual: { color: 'purple', shape: 'square' },
    stats: { hp: 170, maxHp: 170, attack: 28, defense: 10, speed: 7, range: 3 },
    ability: { name: 'Mirage', description: 'Damages and blinds all enemies (30% miss chance)', cooldown: 4 },
  },

  // ── BOSSES (tier 4, enemy-only) ─────────────────────────────────────────────
  {
    id: 'boss_flame_tyrant', name: '🔥 SUN DRAGON SEL', element: 'fire', cost: 0, tier: 4, isBoss: true,
    visual: { color: 'red', shape: 'squircle' },
    stats: { hp: 425, maxHp: 425, attack: 32, defense: 14, speed: 5, range: 4 },
    ability: { name: "Tyrant's Wrath", description: 'AoE fire damage to all enemies', cooldown: 4 },
    bossPhases: [
      { hpThreshold: 1.0, name: 'Burning Fury',   statModifiers: {},                description: 'The Flame Tyrant burns with fury!' },
      { hpThreshold: 0.5, name: 'Inferno',         statModifiers: { attackMult: 1.4 }, description: 'ENRAGED! Attack increased by 40%!' },
    ],
  },
  {
    id: 'boss_frost_colossus', name: '🧊 FROST GIANT ANVALOG', element: 'ice', cost: 0, tier: 4, isBoss: true,
    visual: { color: 'blue', shape: 'circle' },
    stats: { hp: 675, maxHp: 675, attack: 30, defense: 22, speed: 3, range: 4 },
    ability: { name: 'Absolute Zero', description: 'Freezes all enemies for 2 turns + self-heal 80 HP', cooldown: 5, freezeDuration: 2, healAmount: 80 },
    bossPhases: [
      { hpThreshold: 1.0, name: "Frozen Fortress",  statModifiers: {},                                    description: 'The Frost Colossus raises its icy defenses!' },
      { hpThreshold: 0.5, name: "Glacier's Wrath",  statModifiers: { defenseMult: 1.5, speedMult: 0.8 }, description: 'FORTIFIED! Defense increased by 50%!' },
    ],
  },
  {
    id: 'boss_chaos_overlord', name: '🕳️ THE VOID SUPREME', element: 'void', cost: 0, tier: 4, isBoss: true,
    visual: { color: 'purple', shape: 'square' },
    stats: { hp: 450, maxHp: 450, attack: 45, defense: 20, speed: 7, range: 4 },
    ability: { name: 'Void Cataclysm', description: 'Unleashes void energy + enrage at low HP', cooldown: 4 },
    bossPhases: [
      { hpThreshold: 1.0, phaseHp: 300, name: 'Awakening',   statModifiers: {},                                        description: 'The Void Supreme awakens!' },
      { hpThreshold: 0.66, phaseHp: 350, name: 'Corruption',  statModifiers: { attackMult: 1.3, speedMult: 1.2 },      description: 'Phase 2: CORRUPTION! (+30% ATK, +20% SPD)' },
      { hpThreshold: 0.33, phaseHp: 400, name: 'Cataclysm',   statModifiers: { attackMult: 1.6, speedMult: 1.5, defenseMult: 0.7 }, description: 'FINAL PHASE: CATACLYSM!' },
    ],
  },

  // ── VOID CAMPAIGN BOSSES (Wave 20 & 25) ─────────────────────────────────────
  {
    id: 'boss_void_leviathan', name: '🕳️ VOID LEVIATHAN', element: 'void', cost: 0, tier: 4, isBoss: true, isVoid: true,
    visual: { color: 'purple', shape: 'circle' },
    stats: { hp: 800, maxHp: 800, attack: 52, defense: 25, speed: 5, range: 4 },
    ability: { name: 'Abyssal Devour', description: 'Consumes target HP, heals self, applies wound + weaken', cooldown: 4, healAmount: 60 },
    bossPhases: [
      { hpThreshold: 1.0, phaseHp: 500, name: 'Emergence',   statModifiers: {},                                        description: 'The Void Leviathan emerges from the abyss!' },
      { hpThreshold: 0.5, phaseHp: 600, name: 'Deep Hunger', statModifiers: { attackMult: 1.4, speedMult: 1.3 },      description: 'Phase 2: DEEP HUNGER! (+40% ATK, +30% SPD)' },
    ],
  },
  {
    id: 'boss_void_architect', name: '🕳️ THE VOID ARCHITECT', element: 'void', cost: 0, tier: 4, isBoss: true, isVoid: true,
    visual: { color: 'purple', shape: 'rhombus' },
    stats: { hp: 600, maxHp: 600, attack: 60, defense: 18, speed: 8, range: 4 },
    ability: { name: 'Reality Tear', description: 'Massive void damage to all + blind + poison', cooldown: 5 },
    bossPhases: [
      { hpThreshold: 1.0,  phaseHp: 400, name: 'Blueprint',      statModifiers: {},                                                            description: 'The Void Architect studies your formation!' },
      { hpThreshold: 0.66, phaseHp: 450, name: 'Reconstruction',  statModifiers: { attackMult: 1.3, defenseMult: 1.3 },                        description: 'Phase 2: RECONSTRUCTION! (+30% ATK & DEF)' },
      { hpThreshold: 0.33, phaseHp: 500, name: 'Annihilation',    statModifiers: { attackMult: 1.8, speedMult: 1.5, defenseMult: 0.5 },        description: 'FINAL PHASE: ANNIHILATION!' },
    ],
  },
];

// ─── Unit lookup map ──────────────────────────────────────────────────────────
const UNIT_MAP = Object.fromEntries(UNIT_DEFINITIONS.map(u => [u.id, u]));

// Face letters: a=smile  c=angry  f=smug  g=shocked  h=sunglasses  i=grumpy  j=wink  k=silly
// k=happy, h=confident, l=mischievous, f=smug, e=surprised, a=neutral
const GOOD_FACES = {
  fire_imp: 'l',        ice_slime: 'k',        earth_golem: 'h',     lightning_sprite: 'k',
  earth_archer: 'f',    fire_scout: 'l',        fire_warrior: 'h',    ice_archer: 'f',
  arcane_mage: 'f',     lightning_knight: 'h',  ice_guardian: 'h',    arcane_assassin: 'l',
  fire_demon: 'f',      martial_master: 'h',    lightning_lord: 'h',  ice_empress: 'f',
  frost_fairy: 'k',     nature_spirit: 'k',     arcane_priest: 'k',   life_guardian: 'h',
  void_shade: 'l',      void_knight: 'h',       void_horror: 'f',     void_blighter: 'l',
  blood_sprite: 'l',    blood_knight: 'h',      konji_scout: 'l',     konji_shaman: 'k',
  arcane_pupil: 'k',    earth_enforcer: 'h',    lightning_hunter: 'l',
  fire_ravager: 'f',    arcane_illusionist: 'l',
  boss_flame_tyrant: 'h', boss_frost_colossus: 'h', boss_chaos_overlord: 'f',
  boss_void_leviathan: 'h', boss_void_architect: 'f',
  default: 'k',
};

// g=menacing, b=angry, d=skeptical, i=grumpy, c=worried
const EVIL_FACES = {
  fire_imp: 'b',        ice_slime: 'i',         earth_golem: 'i',     lightning_sprite: 'g',
  earth_archer: 'b',    fire_scout: 'd',         fire_warrior: 'b',    ice_archer: 'd',
  arcane_mage: 'd',     lightning_knight: 'b',   ice_guardian: 'i',    arcane_assassin: 'g',
  fire_demon: 'g',      martial_master: 'b',     lightning_lord: 'g',  ice_empress: 'i',
  frost_fairy: 'c',     nature_spirit: 'i',      arcane_priest: 'd',   life_guardian: 'i',
  void_shade: 'g',      void_knight: 'b',        void_horror: 'g',     void_blighter: 'g',
  blood_sprite: 'g',    blood_knight: 'b',       konji_scout: 'd',     konji_shaman: 'b',
  arcane_pupil: 'c',    earth_enforcer: 'i',     lightning_hunter: 'g',
  fire_ravager: 'b',    arcane_illusionist: 'd',
  boss_flame_tyrant: 'g', boss_frost_colossus: 'b', boss_chaos_overlord: 'g',
  boss_void_leviathan: 'g', boss_void_architect: 'g',
  default: 'g',
};

// Sprite cache: populated by preloadSprites()
const SPRITE_CACHE = {};
const PNG_BODY_COLORS = ['red', 'blue', 'green', 'yellow', 'purple', 'pink'];
const PNG_BODY_SHAPES = ['circle', 'rhombus', 'square', 'squircle'];
const HAND_POSES = ['closed', 'open', 'peace', 'point', 'rock', 'thumb'];
const FACIAL_PARTS = [
  'eye_closed_down', 'eye_closed_up', 'eye_half_bottom', 'eye_half_top',
  'eye_half_top_wing', 'eye_open', 'eyebrow_a', 'eyebrow_b', 'eyebrow_c',
  'eyebrow_d', 'mouth_angry', 'mouth_happy', 'mouth_sad', 'mouth_smirk',
];

function preloadSprites(basePath = 'public/sprites/shapes') {
  const entries = [];
  // Body sprites (6 colors × 4 shapes)
  for (const color of PNG_BODY_COLORS) {
    for (const shape of PNG_BODY_SHAPES) {
      entries.push({ key: `${color}_${shape}`, src: `${basePath}/${color}_body_${shape}.png` });
    }
  }
  // Face expressions (a–l)
  for (let i = 0; i < 12; i++) {
    const letter = String.fromCharCode(97 + i);
    entries.push({ key: `face_${letter}`, src: `${basePath}/face_${letter}.png` });
  }
  // Hand sprites (6 colors × 6 poses) — yellow uses different naming
  for (const color of PNG_BODY_COLORS) {
    for (const pose of HAND_POSES) {
      const filename = color === 'yellow'
        ? `hand_yellow_${pose}.png`
        : `${color}_hand_${pose}.png`;
      entries.push({ key: `hand_${color}_${pose}`, src: `${basePath}/${filename}` });
    }
  }
  // Facial parts (individual eyes, eyebrows, mouths)
  for (const part of FACIAL_PARTS) {
    entries.push({ key: `facial_${part}`, src: `${basePath}/facial_part_${part}.png` });
  }
  return Promise.all(entries.map(({ key, src }) =>
    new Promise(resolve => {
      const img = new Image();
      img.onload  = () => { SPRITE_CACHE[key] = img; resolve(); };
      img.onerror = () => resolve();
      img.src = src;
    })
  ));
}

// ─── Game Config ──────────────────────────────────────────────────────────────
const GAME_CONFIG = {
  startingGold:          10,
  goldPerWave:            7,
  maxUnits:               7,
  shopSize:               5,
  shopRefreshCost:        2,
  maxRefreshCost:         3,
  maxRefreshesPerRound:   1,
  sellRefundPercent:    0.50,
  minSellValue:           1,
  waveCount:             15,
  interestRate:           0,
  maxInterest:            5,
  healingRate:          0.25,
};

const GRID_CONFIG = {
  cols: 6,
  rows: 5,
  tileSize: 88,         // px — matches CSS --tile-size
  playerZoneRows: 2,
  enemyZoneRows: 2,
  battleLineRow: 2,
};

// ─── Campaign Modes ───────────────────────────────────────────────────────────
const CAMPAIGN_MODES = {
  normal: {
    id: 'normal', name: 'Normal Campaign', waveCount: 15,
    description: '15 waves — defeat the Void Supreme!',
    unlocked: true,
  },
  void: {
    id: 'void', name: 'Void Campaign', waveCount: 25,
    description: '25 waves — descend into the Void Abyss!',
    unlocked: false,  // requires localStorage 'shape_strikers_void_unlocked'
  },
};

// Enemy stat scaling for waves 16+ (Void Campaign hard mode)
// Applied multiplicatively to base stats of spawned enemies
const HARD_MODE_SCALING = {
  16: { hp: 1.15, attack: 1.10, defense: 1.10, speed: 1.05 },
  17: { hp: 1.20, attack: 1.15, defense: 1.15, speed: 1.05 },
  18: { hp: 1.30, attack: 1.20, defense: 1.20, speed: 1.10 },
  19: { hp: 1.40, attack: 1.25, defense: 1.25, speed: 1.10 },
  20: { hp: 1.50, attack: 1.30, defense: 1.30, speed: 1.15 },  // Boss wave
  21: { hp: 1.55, attack: 1.35, defense: 1.35, speed: 1.15 },
  22: { hp: 1.65, attack: 1.40, defense: 1.40, speed: 1.20 },
  23: { hp: 1.75, attack: 1.45, defense: 1.45, speed: 1.20 },
  24: { hp: 1.85, attack: 1.50, defense: 1.50, speed: 1.25 },
  25: { hp: 2.00, attack: 1.60, defense: 1.55, speed: 1.30 },  // Final boss
};

// ─── Wave Templates (seeded + rules + bias) ──────────────────────────────────
// Boss waves (5, 10, 15) are fixed. Non-boss waves use templates with role slots.
// Roles: tank, skirmisher, sniper, caster, healer
// Difficulty: 'easy' | 'standard' | 'hard' | 'variant'

const BOSS_WAVES = {
  5:  { bonusGold: 15, enemies: [{ unitId: 'boss_flame_tyrant', count: 1 }, { role: 'skirmisher', count: 3 }, { role: 'tank', count: 1 }, { role: 'sniper', count: 1 }] },
  10: { bonusGold: 25, enemies: [{ unitId: 'boss_frost_colossus', count: 1 }, { role: 'tank', count: 3 }, { role: 'healer', count: 2 }, { role: 'sniper', count: 2 }] },
  15: { bonusGold: 50, enemies: [{ unitId: 'boss_chaos_overlord', count: 1 }, { role: 'caster', count: 3 }, { role: 'tank', count: 3 }, { role: 'skirmisher', count: 3 }, { role: 'healer', count: 1 }] },
  // Void Campaign bosses
  20: { bonusGold: 40, enemies: [{ unitId: 'boss_void_leviathan', count: 1 }, { role: 'tank', count: 3 }, { role: 'caster', count: 3 }, { role: 'healer', count: 2 }, { role: 'sniper', count: 2 }] },
  25: { bonusGold: 75, enemies: [{ unitId: 'boss_void_architect', count: 1 }, { role: 'caster', count: 4 }, { role: 'tank', count: 4 }, { role: 'skirmisher', count: 3 }, { role: 'healer', count: 2 }] },
};

const WAVE_TEMPLATES = [
  // Wave 1 — gentle intro
  { wave: 1, bonusGold: 4, difficulty: ['easy'], templates: [
    { slots: [{ role: 'skirmisher', count: 2 }, { role: 'tank', count: 1 }] },
    { slots: [{ role: 'skirmisher', count: 1 }, { role: 'sniper', count: 1 }, { role: 'tank', count: 1 }] },
  ]},
  // Wave 2
  { wave: 2, bonusGold: 5, difficulty: ['easy', 'standard'], templates: [
    { slots: [{ role: 'skirmisher', count: 2 }, { role: 'tank', count: 1 }, { role: 'sniper', count: 1 }] },
    { slots: [{ role: 'skirmisher', count: 2 }, { role: 'sniper', count: 2 }] },
    { slots: [{ role: 'tank', count: 2 }, { role: 'skirmisher', count: 2 }] },
  ]},
  // Wave 3 — first void can appear
  { wave: 3, bonusGold: 6, difficulty: ['standard'], templates: [
    { slots: [{ role: 'tank', count: 2 }, { role: 'skirmisher', count: 2 }, { role: 'sniper', count: 1 }] },
    { slots: [{ role: 'skirmisher', count: 3 }, { role: 'tank', count: 1 }, { role: 'sniper', count: 1 }] },
    { slots: [{ role: 'tank', count: 1 }, { role: 'skirmisher', count: 2 }, { role: 'caster', count: 1 }, { role: 'sniper', count: 1 }] },
  ]},
  // Wave 4
  { wave: 4, bonusGold: 6, difficulty: ['standard', 'hard'], templates: [
    { slots: [{ role: 'tank', count: 2 }, { role: 'skirmisher', count: 2 }, { role: 'caster', count: 1 }, { role: 'sniper', count: 1 }] },
    { slots: [{ role: 'skirmisher', count: 3 }, { role: 'sniper', count: 2 }, { role: 'healer', count: 1 }] },
    { slots: [{ role: 'tank', count: 2 }, { role: 'caster', count: 2 }, { role: 'skirmisher', count: 1 }] },
  ]},
  // Wave 6
  { wave: 6, bonusGold: 12, difficulty: ['standard', 'hard'], templates: [
    { slots: [{ role: 'tank', count: 2 }, { role: 'skirmisher', count: 2 }, { role: 'caster', count: 1 }, { role: 'sniper', count: 1 }] },
    { slots: [{ role: 'tank', count: 1 }, { role: 'skirmisher', count: 3 }, { role: 'healer', count: 1 }, { role: 'sniper', count: 1 }] },
    { slots: [{ role: 'caster', count: 2 }, { role: 'tank', count: 2 }, { role: 'skirmisher', count: 2 }] },
  ]},
  // Wave 7
  { wave: 7, bonusGold: 10, difficulty: ['standard', 'hard'], templates: [
    { slots: [{ role: 'caster', count: 2 }, { role: 'sniper', count: 2 }, { role: 'tank', count: 1 }, { role: 'skirmisher', count: 2 }] },
    { slots: [{ role: 'tank', count: 2 }, { role: 'caster', count: 1 }, { role: 'sniper', count: 2 }, { role: 'healer', count: 1 }, { role: 'skirmisher', count: 1 }] },
  ]},
  // Wave 8
  { wave: 8, bonusGold: 12, difficulty: ['hard'], templates: [
    { slots: [{ role: 'tank', count: 2 }, { role: 'caster', count: 2 }, { role: 'skirmisher', count: 2 }, { role: 'healer', count: 1 }] },
    { slots: [{ role: 'tank', count: 3 }, { role: 'sniper', count: 2 }, { role: 'caster', count: 1 }, { role: 'skirmisher', count: 1 }] },
  ]},
  // Wave 9
  { wave: 9, bonusGold: 14, difficulty: ['hard'], templates: [
    { slots: [{ role: 'tank', count: 2 }, { role: 'caster', count: 2 }, { role: 'sniper', count: 2 }, { role: 'healer', count: 1 }] },
    { slots: [{ role: 'tank', count: 3 }, { role: 'skirmisher', count: 2 }, { role: 'caster', count: 1 }, { role: 'sniper', count: 1 }] },
  ]},
  // Wave 11
  { wave: 11, bonusGold: 15, difficulty: ['hard', 'variant'], templates: [
    { slots: [{ role: 'tank', count: 2 }, { role: 'caster', count: 2 }, { role: 'skirmisher', count: 2 }, { role: 'healer', count: 1 }, { role: 'sniper', count: 1 }] },
    { slots: [{ role: 'caster', count: 3 }, { role: 'tank', count: 2 }, { role: 'skirmisher', count: 2 }, { role: 'healer', count: 1 }] },
  ]},
  // Wave 12
  { wave: 12, bonusGold: 16, difficulty: ['hard', 'variant'], templates: [
    { slots: [{ role: 'tank', count: 3 }, { role: 'caster', count: 2 }, { role: 'sniper', count: 2 }, { role: 'healer', count: 1 }, { role: 'skirmisher', count: 2 }] },
    { slots: [{ role: 'caster', count: 3 }, { role: 'tank', count: 2 }, { role: 'skirmisher', count: 3 }, { role: 'sniper', count: 1 }] },
  ]},
  // Wave 13
  { wave: 13, bonusGold: 18, difficulty: ['hard', 'variant'], templates: [
    { slots: [{ role: 'tank', count: 3 }, { role: 'caster', count: 3 }, { role: 'skirmisher', count: 2 }, { role: 'healer', count: 1 }, { role: 'sniper', count: 1 }] },
    { slots: [{ role: 'caster', count: 2 }, { role: 'tank', count: 3 }, { role: 'skirmisher', count: 3 }, { role: 'healer', count: 1 }, { role: 'sniper', count: 2 }] },
  ]},
  // Wave 14
  { wave: 14, bonusGold: 20, difficulty: ['hard', 'variant'], templates: [
    { slots: [{ role: 'tank', count: 3 }, { role: 'caster', count: 3 }, { role: 'skirmisher', count: 3 }, { role: 'sniper', count: 2 }, { role: 'healer', count: 1 }] },
    { slots: [{ role: 'caster', count: 4 }, { role: 'tank', count: 3 }, { role: 'skirmisher', count: 2 }, { role: 'sniper', count: 2 }] },
  ]},

  // ── VOID CAMPAIGN WAVES (16–25) ─────────────────────────────────────────────
  // Wave 16 — Void Campaign begins, enemy stats scale via HARD_MODE_SCALING
  { wave: 16, bonusGold: 22, difficulty: ['hard', 'variant'], templates: [
    { slots: [{ role: 'tank', count: 3 }, { role: 'caster', count: 3 }, { role: 'skirmisher', count: 2 }, { role: 'healer', count: 1 }, { role: 'sniper', count: 2 }] },
    { slots: [{ role: 'skirmisher', count: 4 }, { role: 'tank', count: 3 }, { role: 'caster', count: 2 }, { role: 'sniper', count: 2 }] },
  ]},
  // Wave 17
  { wave: 17, bonusGold: 24, difficulty: ['hard', 'variant'], templates: [
    { slots: [{ role: 'tank', count: 3 }, { role: 'caster', count: 3 }, { role: 'skirmisher', count: 3 }, { role: 'healer', count: 1 }, { role: 'sniper', count: 2 }] },
    { slots: [{ role: 'caster', count: 4 }, { role: 'tank', count: 3 }, { role: 'skirmisher', count: 3 }, { role: 'healer', count: 1 }] },
  ]},
  // Wave 18
  { wave: 18, bonusGold: 26, difficulty: ['hard', 'variant'], templates: [
    { slots: [{ role: 'tank', count: 4 }, { role: 'caster', count: 3 }, { role: 'skirmisher', count: 3 }, { role: 'healer', count: 2 }, { role: 'sniper', count: 2 }] },
    { slots: [{ role: 'caster', count: 4 }, { role: 'tank', count: 4 }, { role: 'skirmisher', count: 2 }, { role: 'sniper', count: 2 }, { role: 'healer', count: 1 }] },
  ]},
  // Wave 19
  { wave: 19, bonusGold: 30, difficulty: ['hard', 'variant'], templates: [
    { slots: [{ role: 'tank', count: 4 }, { role: 'caster', count: 4 }, { role: 'skirmisher', count: 3 }, { role: 'healer', count: 2 }, { role: 'sniper', count: 2 }] },
    { slots: [{ role: 'skirmisher', count: 4 }, { role: 'caster', count: 4 }, { role: 'tank', count: 3 }, { role: 'healer', count: 2 }, { role: 'sniper', count: 1 }] },
  ]},
  // Wave 20 = boss_void_leviathan (defined in BOSS_WAVES)
  // Wave 21
  { wave: 21, bonusGold: 32, difficulty: ['variant'], templates: [
    { slots: [{ role: 'tank', count: 4 }, { role: 'caster', count: 4 }, { role: 'skirmisher', count: 3 }, { role: 'healer', count: 2 }, { role: 'sniper', count: 2 }] },
    { slots: [{ role: 'caster', count: 5 }, { role: 'tank', count: 4 }, { role: 'skirmisher', count: 3 }, { role: 'healer', count: 1 }] },
  ]},
  // Wave 22
  { wave: 22, bonusGold: 34, difficulty: ['variant'], templates: [
    { slots: [{ role: 'tank', count: 5 }, { role: 'caster', count: 4 }, { role: 'skirmisher', count: 3 }, { role: 'healer', count: 2 }, { role: 'sniper', count: 2 }] },
    { slots: [{ role: 'skirmisher', count: 5 }, { role: 'tank', count: 4 }, { role: 'caster', count: 4 }, { role: 'healer', count: 2 }] },
  ]},
  // Wave 23
  { wave: 23, bonusGold: 36, difficulty: ['variant'], templates: [
    { slots: [{ role: 'tank', count: 5 }, { role: 'caster', count: 5 }, { role: 'skirmisher', count: 3 }, { role: 'healer', count: 2 }, { role: 'sniper', count: 2 }] },
    { slots: [{ role: 'caster', count: 5 }, { role: 'tank', count: 4 }, { role: 'skirmisher', count: 4 }, { role: 'healer', count: 2 }, { role: 'sniper', count: 2 }] },
  ]},
  // Wave 24
  { wave: 24, bonusGold: 40, difficulty: ['variant'], templates: [
    { slots: [{ role: 'tank', count: 5 }, { role: 'caster', count: 5 }, { role: 'skirmisher', count: 4 }, { role: 'healer', count: 2 }, { role: 'sniper', count: 3 }] },
    { slots: [{ role: 'caster', count: 6 }, { role: 'tank', count: 5 }, { role: 'skirmisher', count: 4 }, { role: 'healer', count: 2 }] },
  ]},
  // Wave 25 = boss_void_architect (defined in BOSS_WAVES)
];

// ─── Seeded Wave Generator ────────────────────────────────────────────────────
const WaveGenerator = (() => {
  // Simple seeded PRNG (mulberry32)
  function _mulberry32(seed) {
    return function() {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = t + Math.imul(t ^ (t >>> 7), 61 | t) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  let _rng = _mulberry32(Date.now());

  function setSeed(seed) { _rng = _mulberry32(seed); }

  // Pick random element from array using seeded RNG
  function _pick(arr) { return arr[Math.floor(_rng() * arr.length)]; }

  // Max tier available at a given wave number
  function _maxTier(wave) { return Math.min(3, Math.ceil(wave / 3)); }

  // Build a filtered pool: non-boss units matching role + tier cap.
  // Void units only if already encountered void enemies (wave 3+).
  // Arcane units always available to enemies.
  function _getPool(role, wave) {
    const maxT = _maxTier(wave);
    return UNIT_DEFINITIONS.filter(d => {
      if (d.isBoss) return false;
      if (d.role !== role) return false;
      if (d.tier > maxT) return false;
      // Void units only appear wave 3+ for enemies
      if (d.isVoid && wave < 3) return false;
      return true;
    });
  }

  // Guarantee rule: every N waves, force include a healer or anti-heal caster
  function _shouldForceCounter(wave) {
    return wave >= 4 && wave % 3 === 1; // waves 4, 7, 10(boss handles), 13
  }

  // Generate enemy list for a single wave
  function generate(waveNumber) {
    const totalWaves = GAME_CONFIG.waveCount || 15;

    // Boss waves are fixed (with role-slot boss escorts resolved)
    if (BOSS_WAVES[waveNumber]) {
      const bw = BOSS_WAVES[waveNumber];
      const result = [];
      for (const entry of bw.enemies) {
        if (entry.unitId) {
          // Fixed unit (boss)
          for (let i = 0; i < entry.count; i++) result.push(entry.unitId);
        } else if (entry.role) {
          // Role-based escort — resolve from pool
          const pool = _getPool(entry.role, waveNumber);
          for (let i = 0; i < entry.count; i++) {
            result.push(pool.length > 0 ? _pick(pool).id : 'fire_imp');
          }
        }
      }
      return { waveNumber, bonusGold: bw.bonusGold, enemies: _collapse(result) };
    }

    // Non-boss waves: find template definition
    const tmplDef = WAVE_TEMPLATES.find(t => t.wave === waveNumber);
    if (!tmplDef) {
      // Fallback for any wave without an explicit template — scale from nearest
      return _generateFallback(waveNumber, totalWaves);
    }

    // Pick a random template from the options
    const template = _pick(tmplDef.templates);
    const unitIds = [];

    for (const slot of template.slots) {
      const pool = _getPool(slot.role, waveNumber);
      for (let i = 0; i < slot.count; i++) {
        if (pool.length > 0) {
          // Bias toward variety: avoid picking the same unit too many times
          const picked = _pickWithVariety(pool, unitIds);
          unitIds.push(picked.id);
        } else {
          unitIds.push('fire_imp'); // absolute fallback
        }
      }
    }

    // Guarantee at least one counter unit (healer/caster) on certain waves
    if (_shouldForceCounter(waveNumber)) {
      const hasHealer = unitIds.some(id => UNIT_MAP[id]?.role === 'healer');
      if (!hasHealer) {
        const healerPool = _getPool('healer', waveNumber);
        if (healerPool.length > 0) {
          // Replace a random skirmisher with a healer
          const skirmIdx = unitIds.findIndex(id => UNIT_MAP[id]?.role === 'skirmisher');
          if (skirmIdx >= 0) unitIds[skirmIdx] = _pick(healerPool).id;
        }
      }
    }

    return { waveNumber, bonusGold: tmplDef.bonusGold, enemies: _collapse(unitIds) };
  }

  // Pick from pool with soft bias toward units not yet in the army
  function _pickWithVariety(pool, existing) {
    // Count how many times each pool unit already appears
    const counts = {};
    for (const id of existing) counts[id] = (counts[id] || 0) + 1;

    // Prefer units that appear less (weighted)
    const weighted = pool.map(d => {
      const c = counts[d.id] || 0;
      return { def: d, weight: Math.max(1, 4 - c) };
    });
    const totalWeight = weighted.reduce((s, w) => s + w.weight, 0);
    let r = _rng() * totalWeight;
    for (const w of weighted) {
      r -= w.weight;
      if (r <= 0) return w.def;
    }
    return weighted[weighted.length - 1].def;
  }

  // Fallback generator for undefined wave numbers
  function _generateFallback(waveNumber, totalWaves) {
    const unitCount = Math.min(12, 3 + Math.floor(waveNumber * 0.8));
    const unitIds = [];
    const roles = ['tank', 'skirmisher', 'sniper', 'caster', 'healer'];
    // Rough distribution: 30% tank, 25% skirmisher, 20% sniper, 15% caster, 10% healer
    const dist = [0.3, 0.25, 0.2, 0.15, 0.1];
    for (let i = 0; i < unitCount; i++) {
      let r = _rng();
      let roleIdx = 0;
      for (let j = 0; j < dist.length; j++) {
        r -= dist[j];
        if (r <= 0) { roleIdx = j; break; }
      }
      const pool = _getPool(roles[roleIdx], waveNumber);
      unitIds.push(pool.length > 0 ? _pickWithVariety(pool, unitIds).id : 'fire_imp');
    }
    const bonusGold = Math.round(4 + waveNumber * 1.2);
    return { waveNumber, bonusGold, enemies: _collapse(unitIds) };
  }

  // Collapse flat array of unitIds into [{unitId, count}]
  function _collapse(ids) {
    const map = {};
    for (const id of ids) map[id] = (map[id] || 0) + 1;
    return Object.entries(map).map(([unitId, count]) => ({ unitId, count }));
  }

  return { generate, setSeed };
})();

// Keep a WAVES-compatible getter so the rest of the game can look up bonusGold etc.
// Wave definitions are generated lazily per run.
const WAVES = { length: GAME_CONFIG.waveCount || 15 };

// ─── Shape drawing helpers (Canvas 2D) ────────────────────────────────────────
const SHAPE_COLORS = {
  red:    '#ff4422', blue:   '#3388ff', green:  '#44bb33', yellow: '#ffee22',
  purple: '#aa44ff', orange: '#ff8822', cyan:   '#22ddff', pink:   '#ff66aa',
  white:  '#ddeeff', dark:   '#334455',
};

// Colour helpers for gradient fills
function lightenColor(hex, amount) {
  const num = parseInt(hex.replace('#', ''), 16);
  const r = Math.min(255, ((num >> 16) & 0xff) + amount);
  const g = Math.min(255, ((num >> 8) & 0xff) + amount);
  const b = Math.min(255, (num & 0xff) + amount);
  return `rgb(${r},${g},${b})`;
}
function darkenColor(hex, amount) {
  const num = parseInt(hex.replace('#', ''), 16);
  const r = Math.max(0, ((num >> 16) & 0xff) - amount);
  const g = Math.max(0, ((num >> 8) & 0xff) - amount);
  const b = Math.max(0, (num & 0xff) - amount);
  return `rgb(${r},${g},${b})`;
}

/**
 * Draw a unit shape onto a 2D canvas context.
 * cx, cy = centre; r = radius
 */
function drawUnitShape(ctx, shape, cx, cy, r, fillColor, strokeColor, isEnemy = false, drawFace = true) {
  ctx.save();

  // Build radial gradient for a 3D-ish look (lighter centre → darker edge)
  const grad = ctx.createRadialGradient(cx - r * 0.2, cy - r * 0.25, r * 0.1, cx, cy, r * 1.1);
  grad.addColorStop(0, lightenColor(fillColor, 40));
  grad.addColorStop(0.65, fillColor);
  grad.addColorStop(1, darkenColor(fillColor, 30));

  ctx.fillStyle   = grad;
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth   = 2.5;

  // Subtle glow matching stroke color
  ctx.shadowColor = strokeColor;
  ctx.shadowBlur  = 4;
  ctx.beginPath();

  switch (shape) {
    case 'circle':
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      break;
    case 'square':
      ctx.rect(cx - r, cy - r, r * 2, r * 2);
      break;
    case 'squircle': {
      const w = r * 1.8, h = r * 1.8, rc = r * 0.4;
      const x = cx - w/2, y = cy - h/2;
      ctx.moveTo(x + rc, y);
      ctx.lineTo(x + w - rc, y);   ctx.quadraticCurveTo(x + w, y,     x + w, y + rc);
      ctx.lineTo(x + w, y + h - rc); ctx.quadraticCurveTo(x + w, y + h,   x + w - rc, y + h);
      ctx.lineTo(x + rc, y + h);   ctx.quadraticCurveTo(x, y + h,     x, y + h - rc);
      ctx.lineTo(x, y + rc);       ctx.quadraticCurveTo(x, y,         x + rc, y);
      ctx.closePath();
      break;
    }
    case 'triangle':
      ctx.moveTo(cx, cy - r);
      ctx.lineTo(cx + r * 0.87, cy + r * 0.5);
      ctx.lineTo(cx - r * 0.87, cy + r * 0.5);
      ctx.closePath();
      break;
    case 'rhombus':
      ctx.moveTo(cx, cy - r);
      ctx.lineTo(cx + r * 0.7, cy);
      ctx.lineTo(cx, cy + r);
      ctx.lineTo(cx - r * 0.7, cy);
      ctx.closePath();
      break;
    case 'hexagon': {
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 180) * (60 * i - 30);
        if (i === 0) ctx.moveTo(cx + r * Math.cos(a), cy + r * Math.sin(a));
        else ctx.lineTo(cx + r * Math.cos(a), cy + r * Math.sin(a));
      }
      ctx.closePath();
      break;
    }
    case 'star': {
      const inner = r * 0.45;
      for (let i = 0; i < 10; i++) {
        const a = (Math.PI / 180) * (36 * i - 90);
        const len = i % 2 === 0 ? r : inner;
        if (i === 0) ctx.moveTo(cx + len * Math.cos(a), cy + len * Math.sin(a));
        else ctx.lineTo(cx + len * Math.cos(a), cy + len * Math.sin(a));
      }
      ctx.closePath();
      break;
    }
    case 'pentagon': {
      for (let i = 0; i < 5; i++) {
        const a = (Math.PI / 180) * (72 * i - 90);
        if (i === 0) ctx.moveTo(cx + r * Math.cos(a), cy + r * Math.sin(a));
        else ctx.lineTo(cx + r * Math.cos(a), cy + r * Math.sin(a));
      }
      ctx.closePath();
      break;
    }
    case 'oval':
      ctx.ellipse(cx, cy, r * 1.3, r * 0.8, 0, 0, Math.PI * 2);
      break;
    default:
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
  }

  ctx.fill();
  ctx.stroke();

  // Face (skipped when PNG face sprite will be overlaid)
  if (drawFace) {
    const eyeR = r * 0.1;
    const eyeY = cy - r * 0.15;
    const smileR = r * 0.35;
    ctx.fillStyle = isEnemy ? '#cc0000' : '#ffffff';
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.lineWidth = 1;

    // Eyes
    ctx.beginPath(); ctx.arc(cx - r * 0.22, eyeY, eyeR, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(cx + r * 0.22, eyeY, eyeR, 0, Math.PI * 2); ctx.fill();

    // Mouth
    ctx.beginPath();
    if (isEnemy) {
      ctx.arc(cx, cy + r * 0.2, smileR, Math.PI, 0); // frown
    } else {
      ctx.arc(cx, cy + r * 0.05, smileR, 0, Math.PI); // smile
    }
    ctx.stroke();
  }

  ctx.restore();
}

/**
 * Create a canvas element with a unit's shape drawn on it.
 * Uses PNG body sprites + face overlays when available; falls back to canvas drawing.
 */
function createUnitCanvas(def, isEnemy = false, size = 62) {
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  canvas.className = 'unit-canvas';
  const ctx = canvas.getContext('2d');

  const color = def.visual?.color || 'red';
  const shape = def.visual?.shape || 'circle';

  // Use PNG body sprite if available (5 colors × 4 shapes)
  const bodyKey = `${color}_${shape}`;
  const bodyImg = SPRITE_CACHE[bodyKey];

  // Check if face sprite exists (to decide whether canvas fallback should draw its own face)
  const faceMap    = isEnemy ? EVIL_FACES : GOOD_FACES;
  const faceLetter = faceMap[def.id] || faceMap['default'];
  const faceImg    = SPRITE_CACHE[`face_${faceLetter}`];

  if (bodyImg && PNG_BODY_COLORS.includes(color) && PNG_BODY_SHAPES.includes(shape)) {
    ctx.drawImage(bodyImg, 0, 0, size, size);
  } else {
    // Canvas fallback for new shapes/colors not in PNG set
    const baseColor = SHAPE_COLORS[color] || '#888888';
    const elemColor = ELEMENT_COLORS[def.element] || '#888888';
    const r = size * 0.36;
    drawUnitShape(ctx, shape, size/2, size/2, r, baseColor, elemColor, isEnemy, !faceImg);
  }

  // Face overlay — different expressions for player (friendly) vs enemy (menacing)
  if (faceImg) {
    const fs = size * 0.65;
    ctx.drawImage(faceImg, (size - fs) / 2, (size - fs) / 2 - size * 0.04, fs, fs);
  }

  return canvas;
}

// ─── Patch Notes ──────────────────────────────────────────────────────────────
// Add new entries at the TOP of the array. Each patch = { version, date, notes[] }
const PATCH_NOTES = [
  {
    version: '0.8.0',
    date: 'April 16, 2026',
    title: 'Online Leaderboards',
    notes: [
      '🏆 Global leaderboards — compete for the highest scores worldwide',
      '📅 Daily & Weekly challenge leaderboards with separate rankings',
      '👤 Personal score history — track your best runs',
      '📤 Submit scores after every game (win or lose)',
      '🔒 Anonymous accounts — no sign-up required',
    ],
  },
  {
    version: '0.7.3',
    date: 'April 15, 2026',
    title: 'Daily & Weekly Challenges',
    notes: [
      '📅 New daily challenge — same seed for everyone, resets at midnight',
      '📆 Weekly challenges with 8 unique modifiers (Glass Cannon, Purity, etc.)',
      '🏅 Challenge completion badges on the title screen',
      '📊 Stats tracking for challenge attempts and best scores',
    ],
  },
  {
    version: '0.7.2',
    date: 'April 14, 2026',
    title: 'Achievements & Meta-Progression',
    notes: [
      '🏅 10 achievements to unlock (First Blood, Void Conqueror, and more)',
      '🏆 Post-game accolades — MVP, Executioner, Lifeline, Iron Wall',
      '📈 4 new upgrades: Scouts Intel, Bargain Hunter, Army Expansion, Elemental Mastery',
      '📊 Kill tracking per unit across your run',
    ],
  },
  {
    version: '0.7.1',
    date: 'April 13, 2026',
    title: 'Void Campaign',
    notes: [
      '🕳️ 25-wave Void Campaign — unlocked after beating Normal mode',
      '👾 2 new bosses: Void Leviathan (W20) and Void Architect (W25)',
      '⚡ Hard mode scaling for waves 16–25',
      '🟣 Void element units available in Void Campaign',
    ],
  },
];
