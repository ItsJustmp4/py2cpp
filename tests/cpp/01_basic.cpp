#include <iostream>
using namespace std;

int main() {
    int x = 5;
    cout << x << endl;
    if (x != 3) {
        cout << "ok" << endl;
    } else if (x > 1) {
        cout << "else-if" << endl;
    } else {
        cout << "else" << endl;
    }
    cout << "x = " << x << ", x*2 = " << x * 2 << "\n";
    return 0;
}
