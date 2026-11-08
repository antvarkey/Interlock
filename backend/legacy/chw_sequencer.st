(* ================================================================= *)
(*  CHW PLANT SEQUENCER   V2.3    REV 2004-11-18   R.KOWALSKI         *)
(*  HALL A / HALL B COMMON LOOP                                       *)
(*  DO NOT MODIFY.  SEE PLANT OPS BEFORE ANY CHANGE.                  *)
(*  SCAN = 1 SEC                                                      *)
(* ================================================================= *)

VAR_INPUT
  TS1    : REAL;  (* CHW SUPPLY TEMP C *)
  PF1    : REAL;  (* FACILITY POWER KW *)
  CH1_LD : REAL;  (* CH1 LOAD PCT *)
  CH2_ST : BOOL;  (* CH2 RUN STATUS *)
  MAN_C2 : BOOL;  (* CH2 MANUAL START OVR *)
  AI_77  : REAL;  (* AUX COND FLOW *)
END_VAR

VAR
  TS1_P  : REAL := 7.0;  (* TS1 LAST SCAN *)
  DT     : REAL := 0.0;  (* TS1 DELTA *)
  RR_CT  : INT := 0;     (* RISE COUNTER *)
  ST_CT  : INT := 0;     (* STAGE COUNTER *)
  LK_CT  : INT := 0;     (* LOCKOUT COUNTER *)
  TRP    : BOOL := FALSE;  (* LOOP TRIP LATCH *)
END_VAR

VAR_OUTPUT
  CH2_CM : BOOL := FALSE;  (* CH2 START CMD *)
  PMP_CM : BOOL := TRUE;   (* CHW PUMPS CMD *)
  SHD_CM : BOOL := FALSE;  (* LOAD SHED CMD *)
  AL_9   : BOOL := FALSE;  (* AUX FLOW ALARM *)
END_VAR

(* --- SUPPLY TEMP DELTA --- *)
DT := TS1 - TS1_P;
TS1_P := TS1;

(* --- RISE CHECK (PUMP PROTECT) --- *)
IF DT > 0.10 THEN
  RR_CT := RR_CT + 1;
ELSE
  RR_CT := 0;
END_IF;

(* --- CH1 HEAVY LOAD TIMER --- *)
IF CH1_LD >= 80.0 THEN
  ST_CT := ST_CT + 1;
ELSE
  ST_CT := 0;
END_IF;

(* --- TRIP --- *)
IF RR_CT >= 20 AND NOT TRP THEN
  TRP := TRUE;
  LK_CT := 300;
  PMP_CM := FALSE;
  CH2_CM := FALSE;
END_IF;

(* --- LOCKOUT / RESTART --- *)
IF TRP THEN
  IF LK_CT > 0 THEN
    LK_CT := LK_CT - 1;
  ELSE
    TRP := FALSE;
    PMP_CM := TRUE;
  END_IF;
END_IF;

(* --- CH2 STAGING --- *)
IF ST_CT >= 90 AND NOT TRP THEN
  CH2_CM := TRUE;
END_IF;

(* --- CH2 MANUAL --- *)
IF MAN_C2 AND NOT TRP THEN
  CH2_CM := TRUE;
END_IF;

(* --- POWER CAP --- *)
SHD_CM := PF1 > 1850.0;

(* --- AUX FLOW ALARM (ADDED 2011) --- *)
IF AI_77 > 0.0 THEN
  AL_9 := TRUE;
END_IF;
