"""Witnessed private-server cleanup; never adopt a replacement at the same path."""
def cleanup_owned(reader,run,pid,start,socket):
 rows=[]
 if reader is not None:
  try:
   if reader.returncode is None:reader.terminate();reader.wait(timeout=5)
   rows.append({'childPid':reader.pid,'exit':reader.returncode})
  except BaseException as error:
   try:reader.kill();reader.wait(timeout=5)
   except BaseException as kill_error:rows.append({'error':'child kill failed: '+repr(kill_error)})
   rows.append({'error':'child retirement: '+repr(error)})
 try:
  if pid is None or start is None:raise RuntimeError('No captured server identity; refusing cleanup')
  observed=run('display-message','-p','#{pid}\t#{start_time}').strip().split('\t')
  if observed != [pid,start]:raise RuntimeError('Private server witness mismatch; refusing cleanup')
  run('kill-server');rows.append({'server':'terminated','socket':socket,'identity':observed})
 except BaseException as error:rows.append({'error':'server retirement: '+repr(error),'socket':socket})
 return rows
