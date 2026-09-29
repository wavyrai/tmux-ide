import json,pathlib,tempfile,tarfile,io,unittest,hashlib,importlib.util
from unittest.mock import patch
from admission import ready,unpack,verify_input
R=pathlib.Path(__file__).resolve().parent
class Admission(unittest.TestCase):
 def test_actual_held_descriptor_refuses_before_commands_or_output(self):
  spec=importlib.util.spec_from_file_location('prepare',R/'prepare.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
  with tempfile.TemporaryDirectory() as t,patch.object(m,'run_bounded',side_effect=AssertionError('must never execute')) as run:
   out=pathlib.Path(t)/'output'
   with self.assertRaisesRegex(AssertionError,'Held recipe'):m.prepare(R/'held-inputs.json',pathlib.Path('absent'),pathlib.Path('absent'),pathlib.Path('absent'),out)
   self.assertFalse(out.exists());run.assert_not_called()
 def test_null_actual_pins_refused_even_if_authorized_bit_flipped(self):
  p=json.loads((R/'held-inputs.json').read_text());p['executionAuthorized']=True
  with self.assertRaisesRegex(AssertionError,'Missing actual pin'):ready(p)
 def archive(self,r,link='tool',extra=False):
  path=r/'input.tar';data=b'exact';manifest={'tools':{'kind':'directory','mode':0o700},'tools/tool':{'kind':'file','mode':0o755,'size':5,'sha256':hashlib.sha256(data).hexdigest()},'tools/link':{'kind':'symlink','target':link}}
  with tarfile.open(path,'w') as t:
   for name,item in manifest.items():
    m=tarfile.TarInfo(name);m.mode=item.get('mode',0o777)
    if item['kind']=='directory':m.type=tarfile.DIRTYPE;t.addfile(m)
    elif item['kind']=='symlink':m.type=tarfile.SYMTYPE;m.linkname=link;t.addfile(m)
    else:m.size=5;t.addfile(m,io.BytesIO(data))
   if extra:m=tarfile.TarInfo('extra');t.addfile(m)
  return path,manifest
 def test_exact_inventory_modes_bytes_link_and_mutation(self):
  with tempfile.TemporaryDirectory() as t:
   r=pathlib.Path(t);a,m=self.archive(r);unpack(a,r/'out',m);verify_input(r/'out',m);self.assertEqual((r/'out/tools/tool').stat().st_mode&0o777,0o755)
   (r/'out/tools/tool').write_bytes(b'wrong')
   with self.assertRaises(AssertionError):verify_input(r/'out',m)
 def test_escape_or_extra_member_refused(self):
  for link,extra in [('../../outside',False),('tool',True)]:
   with self.subTest(link=link),tempfile.TemporaryDirectory() as t:
    r=pathlib.Path(t);a,m=self.archive(r,link,extra)
    with self.assertRaises(AssertionError):unpack(a,r/'out',m)
if __name__=='__main__':unittest.main()
