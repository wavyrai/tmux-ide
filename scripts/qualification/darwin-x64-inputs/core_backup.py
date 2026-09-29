"""Reversible whole-checkout move; never delete or reset hosted-image customizations."""
import os, pathlib, stat

def witness(path):
    st=path.lstat()
    assert stat.S_ISDIR(st.st_mode),'Checkout must be a real directory'
    return (st.st_dev,st.st_ino,st.st_mode)

class CoreBackup:
    def __init__(self, core, root, save):
        self.core=pathlib.Path(core);self.root=pathlib.Path(root);self.save=save
        self.original=None;self.replacement=None;self.receipt={'active':False,'restored':False}
    def preserve(self):
        assert not self.root.exists() and not self.root.is_symlink()
        self.original=witness(self.core)
        assert self.root.parent.stat().st_dev==self.original[0],'Cross-device backup refused'
        self.root.mkdir(mode=0o700)
        self.receipt.update({'backup':str(self.root),'originalWitness':self.original})
        self.save(self.receipt)
        assert witness(self.core)==self.original
        os.rename(self.core,self.root/'original')
        self.receipt['active']=True;self.save(self.receipt)
    def admit_replacement(self):
        # Caller just created this absent directory, before starting any Git process.
        self.replacement=witness(self.core)
        self.receipt['replacementWitness']=self.replacement;self.save(self.receipt)
    def restore(self):
        if not self.receipt['active']:return
        try:
            assert witness(self.root/'original')==self.original,'Original backup changed'
            if os.path.lexists(self.core):
                assert self.replacement is not None and witness(self.core)==self.replacement,'Unadmitted replacement blocks restoration'
                assert not os.path.lexists(self.root/'replacement')
                os.rename(self.core,self.root/'replacement')
            assert not os.path.lexists(self.core)
            os.rename(self.root/'original',self.core)
            assert witness(self.core)==self.original
            self.receipt['restored']=True;self.receipt['active']=False
        except Exception as error:
            self.receipt['failureCode']='identity-refused' if isinstance(error,AssertionError) else 'io'
            raise
        finally:self.save(self.receipt)
