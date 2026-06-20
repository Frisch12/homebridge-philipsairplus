// Auto-generated profile index. Lists every built-in DeviceProfile in a
// single map keyed by its public profile id. Edit the per-model files,
// not this index, unless you are wiring up a brand-new profile.
import type { DeviceProfile } from './types.js';
import { CX3550Profile } from './cx3550.js';
import { AC0850_11CProfile } from './ac0850-11c.js';
import { AC0850_20CProfile } from './ac0850-20c.js';
import { AC0850_31CProfile } from './ac0850-31c.js';
import { AC0850_41CProfile } from './ac0850-41c.js';
import { AC0850_70CProfile } from './ac0850-70c.js';
import { AC0850_81Profile } from './ac0850-81.js';
import { AC0950Profile } from './ac0950.js';
import { AC0951Profile } from './ac0951.js';
import { AC2210Profile } from './ac2210.js';
import { AC2220Profile } from './ac2220.js';
import { AC2221Profile } from './ac2221.js';
import { AC3210Profile } from './ac3210.js';
import { AC3220Profile } from './ac3220.js';
import { AC3221Profile } from './ac3221.js';
import { AC3420Profile } from './ac3420.js';
import { AC3421Profile } from './ac3421.js';
import { AC3737Profile } from './ac3737.js';
import { AC4220Profile } from './ac4220.js';
import { AC4221Profile } from './ac4221.js';
import { AMF765Profile } from './amf765.js';
import { AMF870Profile } from './amf870.js';
import { HU1509Profile } from './hu1509.js';
import { HU1510Profile } from './hu1510.js';
import { HU5710Profile } from './hu5710.js';

export const BUILTIN_PROFILES: Record<string, DeviceProfile> = {
  [CX3550Profile.id]: CX3550Profile,
  [AC0850_11CProfile.id]: AC0850_11CProfile,
  [AC0850_20CProfile.id]: AC0850_20CProfile,
  [AC0850_31CProfile.id]: AC0850_31CProfile,
  [AC0850_41CProfile.id]: AC0850_41CProfile,
  [AC0850_70CProfile.id]: AC0850_70CProfile,
  [AC0850_81Profile.id]: AC0850_81Profile,
  [AC0950Profile.id]: AC0950Profile,
  [AC0951Profile.id]: AC0951Profile,
  [AC2210Profile.id]: AC2210Profile,
  [AC2220Profile.id]: AC2220Profile,
  [AC2221Profile.id]: AC2221Profile,
  [AC3210Profile.id]: AC3210Profile,
  [AC3220Profile.id]: AC3220Profile,
  [AC3221Profile.id]: AC3221Profile,
  [AC3420Profile.id]: AC3420Profile,
  [AC3421Profile.id]: AC3421Profile,
  [AC3737Profile.id]: AC3737Profile,
  [AC4220Profile.id]: AC4220Profile,
  [AC4221Profile.id]: AC4221Profile,
  [AMF765Profile.id]: AMF765Profile,
  [AMF870Profile.id]: AMF870Profile,
  [HU1509Profile.id]: HU1509Profile,
  [HU1510Profile.id]: HU1510Profile,
  [HU5710Profile.id]: HU5710Profile,
};

export const BUILTIN_PROFILE_IDS: string[] = Object.keys(BUILTIN_PROFILES);
