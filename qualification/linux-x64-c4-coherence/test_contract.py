import unittest,copy
from coherence_contract import admission,validate_report,COMMIT,TREE,SOURCE,CLI
from fresh_process_host import require_closed_campaign
class Contract(unittest.TestCase):
 def receipt(self):
  return {'source':{'commit':COMMIT,'tree':TREE},'cli':CLI,'cliSha256':'c'*64,'originalClosureUnchanged':True,'stock':{'patches':[],'binarySha256':'a'*64},'closure':{'/work/native/tmux':'8933071dbaeea131b04961ab74ff8b21a622891bce6a01f43ef5122e2fad14d2','/work/current/stock/tmux':'a'*64,**{f'/work/current/coherence/{i}':'b'*64 for i in range(11)}},'processHost':{'bootId':'old'}}
 def test_new_host_and_original_mode_contract(self):
  r=self.receipt();old=copy.deepcopy(r);b={'archiveReceiptSha256':'r'*64,'processHost':{'bootId':'fresh'}}
  for lane in ['native','stock']:
   d=admission(r,lane,'r'*64,b);self.assertEqual(d['processHost'],b['processHost']);self.assertEqual(d['nativeObservation'],'enabled' if lane=='native' else 'disabled')
  self.assertEqual(r,old)
 def test_foreign_receipt_wrong_native_source_and_stock_patch_rejected(self):
  b={'archiveReceiptSha256':'r'*64,'processHost':{}}
  for change in [lambda r:r['source'].update(commit='0'*40),lambda r:r['source'].update(tree='0'*40),lambda r:r.update(cli='/wrong'),lambda r:r['stock'].update(patches=['x']),lambda r:r['closure'].update({'/work/native/tmux':'0'*64})]:
   r=self.receipt();change(r)
   with self.assertRaises(AssertionError):admission(r,'native','r'*64,b)
  with self.assertRaises(AssertionError):admission(self.receipt(),'native','different',b)
 def test_report_original_counts_order_cleanup_and_oracle(self):
  r={'completed':True,'failure':None,'manifest':{'records':500,'clients':[2,4,8],'shapes':[[80+i*2,25+i%7] for i in range(20)],'source':COMMIT,'provenance':{'commit':COMMIT,'tree':TREE,'dirty':''}},'results':[{'count':n,'failures':[],'facts':{'records':500,'count':n,'hashes':['same']*n,'mode':'stock-observation-off','oracleScope':'finite-producer-stock-visible-semantics'},'cleanup':dict.fromkeys(['observation','pty','daemon','server'],'confirmed')} for n in [2,4,8]]}
  self.assertEqual(validate_report(r,'stock')['clients'],[2,4,8])
  for change in [lambda x:x['results'].pop(),lambda x:x['manifest'].update(records=499),lambda x:x['results'][0]['cleanup'].update(server='unknown'),lambda x:x['results'][0]['facts'].update(oracleScope='native')]:
   v=copy.deepcopy(r);change(v)
   with self.assertRaises(AssertionError):validate_report(v,'stock')
if __name__=='__main__':unittest.main()
