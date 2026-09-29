import copy,json,pathlib,unittest
from fresh_process_host import require_closed_campaign
class ClosedPins(unittest.TestCase):
 def test_actual_reviewed_artifact_passes_and_missing_pin_refuses(self):
  d=json.loads((pathlib.Path(__file__).parent/'pins.json').read_text());require_closed_campaign(d)
  self.assertEqual(d['coherenceArtifact']['run'],36606002477)
  self.assertEqual(d['source']['commit'],'be8bcfad29610265716b8dcb657658cf8f1d0ba3')
  for key in ['runtimeArchiveSha256','artifactReceiptSha256','cliSha256','stockSha256','coherenceArtifact']:
   bad=copy.deepcopy(d);bad[key]=None
   with self.assertRaises(AssertionError):require_closed_campaign(bad)
if __name__=='__main__':unittest.main()
