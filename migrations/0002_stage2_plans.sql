-- Stage 2: the plan rows sign-in can reach.
--
-- `free` had zeros, and checkLimits treats a zero cap as NO GATE — so a device
-- bound to a free account would have been uncapped. Stage 1 never reached the
-- row; stage 2 is the thing that does. Numbers now, revisited at stage 3 with
-- pricing (SPEC.md A70, decision D1).
UPDATE plans SET daily_cap = 50, hourly_cap = 20, trial_cap = 0 WHERE name = 'free';

-- `beta` MIRRORS THE ONE LIVE v1 RECORD, measured before this row was written:
-- daily 500, hourly 60. A v1 (baked, hand-set) token that signs in gets an
-- account on this plan, so the tester keeps exactly what they have. Anything
-- else is the demotion A64 recorded and D2(c) exists to prevent. The 200/40 in
-- the README is an example, not a record.
INSERT OR IGNORE INTO plans (name, daily_cap, hourly_cap, trial_cap) VALUES ('beta', 500, 60, 0);
