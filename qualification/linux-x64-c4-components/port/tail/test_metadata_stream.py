import io,json,os,time,unittest
from metadata_stream import MetadataStream
class MetadataTests(unittest.TestCase):
 def test_telemetry_and_replies(self):
  r,w=os.pipe()
  with os.fdopen(r,'rb') as stream:
   seen=time.clock_gettime_ns(time.CLOCK_MONOTONIC)//1000
   os.write(w,(json.dumps({'ready':True})+'\n'+json.dumps({'latency':[{'kind':1,'us':str(seen)}]})+'\n'+json.dumps({'records':1})+'\n').encode());os.close(w)
   drain=MetadataStream(stream);self.assertEqual(drain.reply(),{'ready':True});self.assertEqual(drain.reply(),{'records':1});drain.finish()
   self.assertEqual(len(drain.latencies),1);self.assertGreaterEqual(drain.latencies[0]['milliseconds'],0)
 def test_bad_payload_fails(self):
  r,w=os.pipe()
  with os.fdopen(r,'rb') as stream:
   os.write(w,b'not json\n');os.close(w);drain=MetadataStream(stream)
   with self.assertRaises(RuntimeError):drain.finish()
if __name__=='__main__':unittest.main()
