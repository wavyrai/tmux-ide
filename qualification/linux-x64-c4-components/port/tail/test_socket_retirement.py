import os,socket,tempfile,unittest
from pathlib import Path
from bounded_io import retire_socket
class SocketRetirementTests(unittest.TestCase):
 def test_exact_socket_only(self):
  with tempfile.TemporaryDirectory() as d:
   path=str(Path(d)/'owned.sock')
   with socket.socket(socket.AF_UNIX) as s:
    s.bind(path);st=os.lstat(path);w=(st.st_dev,st.st_ino,st.st_uid)
    with self.assertRaises(RuntimeError):retire_socket(path,(st.st_dev,st.st_ino+1,st.st_uid))
    self.assertTrue(os.path.exists(path));retire_socket(path,w);self.assertFalse(os.path.exists(path))
 def test_regular_file_refused(self):
  with tempfile.TemporaryDirectory() as d:
   path=Path(d)/'owned.sock';path.write_text('keep');st=path.stat()
   with self.assertRaises(RuntimeError):retire_socket(str(path),(st.st_dev,st.st_ino,st.st_uid))
   self.assertEqual(path.read_text(),'keep')
if __name__=='__main__':unittest.main()
