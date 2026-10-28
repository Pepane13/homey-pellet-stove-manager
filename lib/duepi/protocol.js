'use strict';

/**
 * Duepi EVO command set and reply decoders.
 * Sources: community documentation (aceindy/Duepi_EVO, P. Bornat "InterstoveRemoteCmd",
 * motionbug/testcodestove SPEC.md) and captures of the owner's own stove (Phase 0).
 */

const READ = Object.freeze({
  status: 'D9000',
  powerLevel: 'D3000',
  ambient: 'D1000',
  flueGas: 'D0000',
  auger: 'D4000',
  exhaust: 'EF000',
  error: 'DA000',
  setpoint: 'C6000',
  board: 'DF000',
  hoursTotal: 'ED000',
  hoursService: 'EE000',
  pressureSwitch: 'C0000',
});

/** Write commands. Not used before Phase 1 write tests are approved. */
const WRITE = Object.freeze({
  power: (level) => {
    const n = Number(level);
    if (!Number.isInteger(n) || n < 0 || n > 5) throw new Error(`Invalid power level ${level}`);
    return `F00${n}0`; // 0 = shutdown
  },
  setpoint: (celsius) => {
    const n = Math.round(Number(celsius));
    if (!Number.isFinite(n) || n < 5 || n > 35) throw new Error(`Invalid setpoint ${celsius}`);
    return `F2${n.toString(16).toUpperCase().padStart(2, '0')}0`;
  },
  resetAlarm: () => 'D6000',
});

const ACK = 0x00000020;

const ERRORS = Object.freeze({
  0: { id: 'none', en: 'No error', fr: 'Aucune erreur', severity: 0 },
  1: { id: 'ignition_failure', en: 'Ignition failure', fr: "Échec d'allumage", severity: 2 },
  2: { id: 'suction_failure', en: 'Defective suction', fr: 'Aspiration défectueuse', severity: 2 },
  3: { id: 'air_intake', en: 'Insufficient air intake', fr: "Entrée d'air insuffisante", severity: 2 },
  4: { id: 'water_temperature', en: 'Water temperature', fr: "Température d'eau", severity: 2 },
  5: { id: 'out_of_pellets', en: 'Out of pellets', fr: 'Manque de pellets', severity: 1 },
  6: { id: 'pressure_switch', en: 'Defective pressure switch', fr: 'Pressostat défectueux', severity: 3 },
  8: { id: 'power_failure', en: 'Power failure', fr: 'Coupure de courant', severity: 1 },
  9: { id: 'exhaust_motor', en: 'Exhaust motor failure', fr: "Moteur d'extraction", severity: 3 },
  10: { id: 'board_overvoltage', en: 'Board overvoltage', fr: 'Surtension carte', severity: 3 },
  11: { id: 'date_expired', en: 'Date expired', fr: 'Date expirée', severity: 1 },
  13: { id: 'suction_sensor', en: 'Suction regulation sensor error', fr: "Sonde de régulation d'aspiration", severity: 3 },
  14: { id: 'overheating', en: 'Overheating', fr: 'Surchauffe', severity: 3 },
});

const hex4 = (p) => parseInt(p.slice(0, 4), 16);
const hex6 = (p) => parseInt(p.slice(0, 6), 16);

function decodeStatus(payload) {
  const v = parseInt(payload, 16);
  const phase = (v >>> 24) & 0xff;
  let status = 'unknown';
  if (phase & 0x01) status = 'ignition';
  else if (phase & 0x02) status = 'heating';
  else if (phase & 0x04) status = 'cleaning';
  else if (phase & 0x10) status = 'eco';
  else if (phase & 0x08) status = 'cooling';
  else if (v === ACK) status = 'off';
  return { status, raw: payload };
}

function decodeError(payload) {
  const code = hex4(payload);
  const known = ERRORS[code];
  return {
    code,
    id: known ? known.id : `unknown_${code}`,
    en: known ? known.en : `Unknown error ${code}`,
    fr: known ? known.fr : `Erreur inconnue ${code}`,
    severity: known ? known.severity : 2,
  };
}

/** Ambient probe: 99.9 °C means "no probe connected" (stove regulated by an external thermostat). */
function decodeAmbient(payload) {
  const t = hex4(payload) / 10;
  return t >= 99 ? null : t;
}

const DECODERS = Object.freeze({
  status: decodeStatus,
  powerLevel: hex4,
  ambient: decodeAmbient,
  flueGas: hex4,
  auger: hex4,
  exhaust: (p) => hex4(p) * 10, // rpm
  error: decodeError,
  setpoint: (p) => {
    const v = hex4(p);
    return v >= 5 && v <= 35 ? v : null;
  },
  board: hex4,
  hoursTotal: hex6,
  hoursService: hex6,
  pressureSwitch: (p) => {
    const v = hex4(p);
    if (v === 0x0100) return 'normal';
    if (v === 0x0300) return 'pressure';
    return `0x${v.toString(16)}`;
  },
});

function isAck(payload) {
  return typeof payload === 'string' && (parseInt(payload, 16) & ACK) === ACK;
}

module.exports = {
  READ,
  WRITE,
  ERRORS,
  DECODERS,
  decodeStatus,
  decodeError,
  decodeAmbient,
  isAck,
};
