"""A small cooling-plant model used to run the controller forward in time.

It is intentionally simple: a heat load, two chillers with start-up delays and
capacity limits, and a chilled-water loop with thermal mass. The numbers are
illustrative placeholders. Replace them with real values from the facility.
"""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class PlantParams:
    """One data hall, sized from public information about large GPU deployments.

    NMC² does not publish equipment details for its Spartanburg site, so these are
    industry-typical values (see README, "Plant model"). Replace them with real
    values from the facility. Power is in kW, temperatures in °C, times in seconds.
    """
    # IT load: 64 liquid-cooled rack-scale GPU systems at about 130 kW each
    racks: int = 64
    gpus_per_rack: int = 72
    idle_kw: float = 2100.0         # cluster idle (about 25 % of peak)
    full_kw: float = 8300.0         # all racks training at full power
    ramp_s: int = 10                # synchronous job start: idle to full in about 10 s
    staged_frac: float = 0.5        # first stage of a staged start
    staged_hold_s: int = 240        # seconds at the first stage
    # Chilled-water plant: water-cooled centrifugal chillers + evaporative cooling towers,
    # feeding the rack CDUs. 2 duty chillers + 1 standby (N+1); the standby is not modelled.
    chiller_cap_kw: float = 4500.0  # one chiller (about 1,280 tons of refrigeration)
    ch2_delay_s: int = 45           # start command to "running" (vendor fast-start figures: 43 s and up)
    ch2_ramp_s: int = 120           # running to full capacity
    loop_kj_per_c: float = 150000.0  # thermal mass of the facility-water loop (about 36 m3 of water)
    kp_kw_per_c: float = 900.0      # extra cooling per degree above setpoint
    setpoint_c: float = 25.0        # facility-water supply to the CDUs
    throttle_c: float = 32.0        # GPUs throttle above this supply temperature
    shutdown_c: float = 35.0        # GPUs shut down above this supply temperature
    chiller_kw_per_kw: float = 0.17  # chiller electrical power per kW of cooling (about 0.6 kW/ton)
    pump_kw: float = 250.0          # pumps and cooling-tower fans
    shed_frac: float = 0.15         # IT load removed when load shedding is on
    job_start_s: int = 300          # job clock: the job starts this many seconds after it is queued
    after_start_s: int = 420        # how long to simulate after the job starts

    @property
    def duration_s(self) -> int:
        return self.job_start_s + self.after_start_s


def job_target_kw(p: PlantParams, profile: str, t: int) -> float:
    """IT power the job asks for at second t."""
    if t < p.job_start_s:
        return p.idle_kw
    x = t - p.job_start_s
    if profile == "staged":
        half = p.idle_kw + (p.full_kw - p.idle_kw) * p.staged_frac
        if x < p.staged_hold_s:
            return p.idle_kw + (half - p.idle_kw) * min(1.0, x / p.ramp_s)
        return half + (p.full_kw - half) * min(1.0, (x - p.staged_hold_s) / p.ramp_s)
    return p.idle_kw + (p.full_kw - p.idle_kw) * min(1.0, x / p.ramp_s)


class Plant:
    def __init__(self, p: PlantParams):
        self.p = p
        self.temp = p.setpoint_c
        self.ch2_t = 0
        self.pump_on = True
        self.shutdown = False
        self.it_kw = p.idle_kw
        self.cool_kw = p.idle_kw
        self.cap_kw = p.chiller_cap_kw
        self.fac_kw = p.idle_kw * (1 + p.chiller_kw_per_kw) + p.pump_kw

    def sensors(self, manual_c2: bool) -> dict:
        p = self.p
        ch1 = 100.0 * self.cool_kw / self.cap_kw if self.cap_kw > 0 else 0.0
        return {
            "chw_supply_temp_c": self.temp,
            "facility_power_kw": self.fac_kw,
            "chiller1_load_pct": ch1,
            "chiller2_running": self.ch2_t >= p.ch2_delay_s,
            "chiller2_manual_start": manual_c2,
            "aux_cond_flow_77": 0.0,
        }

    def advance(self, outputs: dict, target_kw: float):
        p = self.p
        self.pump_on = bool(outputs["cooling_pumps_cmd"])
        if outputs["chiller2_start_cmd"] and self.pump_on:
            self.ch2_t += 1
        else:
            self.ch2_t = 0
        it = target_kw * (1 - p.shed_frac) if outputs["load_shed_cmd"] else target_kw
        if self.temp >= p.shutdown_c:
            self.shutdown = True
        if self.shutdown:
            it = 0.0
        elif self.temp >= p.throttle_c:
            it *= 0.4
        cap2 = 0.0
        if self.ch2_t >= p.ch2_delay_s:
            cap2 = p.chiller_cap_kw * min(1.0, (self.ch2_t - p.ch2_delay_s) / p.ch2_ramp_s)
        self.cap_kw = (p.chiller_cap_kw + cap2) if self.pump_on else p.chiller_cap_kw
        cap_now = (p.chiller_cap_kw + cap2) if self.pump_on else 0.0
        cool = 0.0 if not self.pump_on else max(0.0, min(cap_now, it + p.kp_kw_per_c * (self.temp - p.setpoint_c)))
        self.temp += (it - cool) / p.loop_kj_per_c
        self.it_kw, self.cool_kw = it, cool
        self.fac_kw = it + p.chiller_kw_per_kw * cool + (p.pump_kw if self.pump_on else 0.0)


@dataclass
class Run:
    params: PlantParams
    profile: str
    manual_ch2_at: int | None
    t: list = field(default_factory=list)
    temp: list = field(default_factory=list)
    it_kw: list = field(default_factory=list)
    fac_kw: list = field(default_factory=list)
    cool_kw: list = field(default_factory=list)
    cap_kw: list = field(default_factory=list)
    pumps: list = field(default_factory=list)
    ch2_running: list = field(default_factory=list)
    fired: list = field(default_factory=list)


def simulate(controller, profile: str = "single", manual_ch2_at: int | None = None,
             params: PlantParams | None = None) -> Run:
    """Run `controller` against the plant. `controller.step(**sensors)` must
    return (outputs, fired_rule_ids) using the modern names."""
    p = params or PlantParams()
    plant = Plant(p)
    run = Run(p, profile, manual_ch2_at)
    controller.reset()
    for t in range(p.duration_s):
        man = manual_ch2_at is not None and t >= manual_ch2_at
        outputs, fired = controller.step(**plant.sensors(man))
        plant.advance(outputs, job_target_kw(p, profile, t))
        run.t.append(t)
        run.temp.append(round(plant.temp, 4))
        run.it_kw.append(round(plant.it_kw, 2))
        run.fac_kw.append(round(plant.fac_kw, 2))
        run.cool_kw.append(round(plant.cool_kw, 2))
        run.cap_kw.append(round(plant.cap_kw if plant.pump_on else 0.0, 2))
        run.pumps.append(plant.pump_on)
        run.ch2_running.append(plant.ch2_t >= p.ch2_delay_s)
        run.fired.append(fired)
    return run
