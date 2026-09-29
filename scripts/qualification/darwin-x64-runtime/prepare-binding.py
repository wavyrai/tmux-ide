"""Bind fully verified archives and stage source; no build/import/workload execution."""
import argparse,json,pathlib
from binding import bind_runtime
from stage import stage_sources

def main():
 p=argparse.ArgumentParser()
 for name in ['runtime-root','runtime-zip','runtime-tar','runtime-proof','reference-root','pins','output']:p.add_argument('--'+name,required=True,type=pathlib.Path)
 a=p.parse_args();pins=json.loads(a.pins.read_text())
 assert not a.output.exists(),'Fresh output required'
 binding=bind_runtime(a.runtime_root,a.runtime_zip,a.runtime_tar,a.runtime_proof,pins,a.reference_root)
 stage_sources(binding,a.output)
 (a.output/'runtime-binding.json').write_text(json.dumps(binding,indent=2)+'\n')
if __name__=='__main__':main()
