import unittest
from cpu_diagnostics import cpu_seconds, readiness_diagnostics

class Accounting(unittest.TestCase):
    def test_preserves_full_accounting_and_units(self):
        ready={"pid":123,"cpu":{"user":40000,"system":20000}}
        final={"cpu":{"user":120000,"system":40000}}
        full=.180
        d=readiness_diagnostics(ready,final,full,.2,{"processes":[]})
        self.assertEqual(d['reader_self_cpu_at_ready_seconds'],.06)
        self.assertAlmostEqual(d['reader_self_cpu_after_ready_reported_seconds'],.10)
        self.assertEqual(d['final_wait4_cpu_including_startup_and_reaped_descendants_seconds'],full)
        self.assertAlmostEqual(d['wait4_minus_ready_self_seconds'],.12)
        self.assertAlmostEqual(d['wait4_minus_stop_self_seconds'],.02)
        # Gate remains workload+server+FULL reader/helpers, never runtime delta.
        workload,server=2.0,.1
        self.assertAlmostEqual(workload+server+full,2.28)
        d['ready_report']['user']=0
        self.assertEqual(ready['cpu']['user'],40000)
    def test_invalid_counters_reject_without_clamping(self):
        for value in [{"user":-1,"system":0},{"user":True,"system":0},{"user":.1,"system":0}]:
            with self.assertRaises(ValueError):cpu_seconds(value)
        with self.assertRaises(ValueError):
            readiness_diagnostics({"cpu":{"user":2,"system":0}}, {"cpu":{"user":1,"system":0}},.1,0,None)

unittest.main()
