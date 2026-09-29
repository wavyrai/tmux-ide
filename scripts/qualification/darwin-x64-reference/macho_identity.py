import struct,hashlib
def inspect(data):
 assert struct.unpack_from('<II',data)==(0xfeedfacf,0x01000007)
 count=struct.unpack_from('<I',data,16)[0];offset=32;sections={};uuid=None
 for _ in range(count):
  cmd,size=struct.unpack_from('<II',data,offset)
  if cmd==0x1b:uuid=data[offset+8:offset+24].hex()
  if cmd==0x19:
   n=struct.unpack_from('<I',data,offset+64)[0]
   for i in range(n):
    start=offset+72+i*80;section,segment=struct.unpack_from('<16s16s',data,start);length,fileoff=struct.unpack_from('<QI',data,start+40);flags=struct.unpack_from('<I',data,start+64)[0]
    key=segment.rstrip(b'\0').decode()+','+section.rstrip(b'\0').decode()
    if flags&255 not in (1,12,18):sections[key]={'size':length,'sha256':hashlib.sha256(data[fileoff:fileoff+length]).hexdigest()}
  offset+=size
 return {'uuid':uuid,'sections':sections}
