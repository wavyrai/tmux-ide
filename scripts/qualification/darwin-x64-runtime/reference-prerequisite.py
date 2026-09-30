"""Admit the reviewed existing four-case reference receipt; never rerun those cases."""
import json,pathlib,re
from binding import sha

def admit(pins,recipe):
 pin=pins['referenceFunctionalReceipt']
 assert pin['file']=='reference-functional-accepted.json','Closed prerequisite filename required'
 assert isinstance(pin['sha256'],str) and re.fullmatch('[0-9a-f]{64}',pin['sha256']),'Reference functional receipt remains unpinned'
 assert isinstance(pin['runId'],int) and not isinstance(pin['runId'],bool) and pin['runId']>0,'Original prerequisite CI run required'
 path=pathlib.Path(recipe)/pin['file'];assert path.is_file() and not path.is_symlink()
 assert sha(path)==pin['sha256'],'Reference functional receipt changed'
 receipt=json.loads(path.read_text())
 assert receipt['passed'] is True and receipt['cases']==4 and receipt['skipped']==0
 assert receipt['cleanup'] is True and receipt['prepostFullAdmission'] is True
 assert receipt['referenceSha256']==pins['matchedReference']['binarySha256'],'Functional proof is for another reference'
 return {'receiptSha256':pin['sha256'],'runId':pin['runId'],'referenceSha256':receipt['referenceSha256'],'cases':4,'rerun':False}
